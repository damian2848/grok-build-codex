import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildBridgeArgs } from "../scripts/run-grok.mjs";
import {
  enqueueBackgroundJob,
  handleTaskWorker
} from "../scripts/upstream/scripts/grok-bridge.mjs";
import {
  patchJobIfActive,
  readJobFile,
  reserveJob,
  resolveJobFile,
  resolveJobLogFile
} from "../scripts/upstream/scripts/lib/state.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(pluginRoot, "scripts", "grok-bridge.mjs");
const initWorkspace = path.join(pluginRoot, "scripts", "init-workspace.mjs");
const runGrok = path.join(pluginRoot, "scripts", "run-grok.mjs");
const fakeGrok = path.join(pluginRoot, "tests", "fake-grok.mjs");

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-to-grok-"));
  spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });
  fs.mkdirSync(path.join(repo, ".ai-collab"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".ai-collab", "task.md"), "Implement the test task.\n");
  return repo;
}

function runBridge(repo, args, extraEnv = {}) {
  return spawnSync(process.execPath, [bridge, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      GROK_BINARY: process.execPath,
      GROK_BINARY_ARGS_JSON: JSON.stringify([fakeGrok]),
      CODEX_THREAD_ID: "019f0000-1111-7222-8333-444444444444",
      ...extraEnv
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
}

function parseJsonLines(output) {
  return String(output)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("Node workspace initializer is idempotent and preserves existing files", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-to-grok-init-"));
  spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });

  const first = spawnSync(process.execPath, [initWorkspace, "--workspace", repo], {
    encoding: "utf8"
  });
  assert.equal(first.status, 0, first.stderr);
  const planFile = path.join(repo, ".ai-collab", "plan.md");
  fs.writeFileSync(planFile, "custom plan\n");

  const second = spawnSync(process.execPath, [initWorkspace, "--workspace", repo], {
    encoding: "utf8"
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(planFile, "utf8"), "custom plan\n");
  assert.ok(fs.existsSync(path.join(repo, ".ai-collab", "runs")));
});

test("cross-platform run wrapper delegates through Node", () => {
  const repo = makeRepo();
  const result = spawnSync(
    process.execPath,
    [runGrok, "--workspace", repo, "--fresh", "--model", "sub2api-grok", "--json"],
    {
      cwd: repo,
      env: {
        ...process.env,
        GROK_BINARY: process.execPath,
        GROK_BINARY_ARGS_JSON: JSON.stringify([fakeGrok]),
        CODEX_THREAD_ID: "019f0000-1111-7222-8333-444444444444"
      },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("cross-platform run wrapper forwards live follow options", () => {
  const args = buildBridgeArgs([
    "--workspace",
    ".",
    "--background",
    "--follow",
    "--stream",
    "--timeout-ms",
    "5000",
    "--poll-interval-ms",
    "50",
    "--heartbeat-ms",
    "1000"
  ]);
  assert.ok(args.includes("--background"));
  assert.ok(args.includes("--follow"));
  assert.ok(args.includes("--stream"));
  assert.deepEqual(args.slice(args.indexOf("--timeout-ms"), args.indexOf("--timeout-ms") + 2), [
    "--timeout-ms",
    "5000"
  ]);
  assert.deepEqual(
    args.slice(args.indexOf("--poll-interval-ms"), args.indexOf("--poll-interval-ms") + 2),
    ["--poll-interval-ms", "50"]
  );
  assert.deepEqual(args.slice(args.indexOf("--heartbeat-ms"), args.indexOf("--heartbeat-ms") + 2), [
    "--heartbeat-ms",
    "1000"
  ]);
});

test("background enqueue never regresses a worker that already started", () => {
  const repo = makeRepo();
  const jobId = "enqueue-race";
  const request = { kind: "task", prompt: "race test", write: true };
  enqueueBackgroundJob(
    repo,
    {
      id: jobId,
      kind: "task",
      kindLabel: "delegate",
      title: "Race test",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "race test",
      write: true,
      createdAt: new Date().toISOString()
    },
    request,
    {
      spawnWorker() {
        patchJobIfActive(repo, jobId, {
          status: "running",
          phase: "editing",
          pid: 4321,
          bridgePid: 4321,
          agentPid: 9876
        });
        return { pid: 4321, once() {} };
      }
    }
  );

  const stored = readJobFile(resolveJobFile(repo, jobId));
  assert.equal(stored.status, "running");
  assert.equal(stored.phase, "editing");
  assert.equal(stored.agentPid, 9876);
  assert.deepEqual(stored.request, request);
});

test("worker bootstrap failures become tracked terminal failures", async () => {
  const repo = makeRepo();
  const jobId = "bootstrap-failure";
  const logFile = resolveJobLogFile(repo, jobId);
  const reservation = reserveJob(repo, {
    id: jobId,
    kind: "task",
    kindLabel: "delegate",
    title: "Bootstrap failure",
    workspaceRoot: repo,
    jobClass: "task",
    summary: "missing request",
    write: true,
    logFile
  });
  assert.equal(reservation.reserved, true);

  await assert.rejects(
    handleTaskWorker(["--cwd", repo, "--job-id", jobId]),
    /missing its run request payload/
  );

  const stored = readJobFile(resolveJobFile(repo, jobId));
  assert.equal(stored.status, "failed");
  assert.equal(stored.phase, "failed");
  assert.match(stored.errorMessage, /missing its run request payload/);
  assert.match(fs.readFileSync(logFile, "utf8"), /Worker bootstrap failed/);
});

test("check reports the fake Grok CLI as ready", () => {
  const repo = makeRepo();
  const result = runBridge(repo, ["check", "--cwd", repo, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.grok.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("foreground delegation stores a completed job and output", () => {
  const repo = makeRepo();
  const traceFile = path.join(repo, "grok-trace.jsonl");
  const task = runBridge(
    repo,
    [
      "run",
      "--write",
      "--fresh",
      "--cwd",
      repo,
      "--prompt-file",
      ".ai-collab/task.md",
      "--model",
      "sub2api-grok",
      "--json"
    ],
    { FAKE_GROK_TRACE_FILE: traceFile }
  );
  assert.equal(task.status, 0, task.stderr);
  const taskPayload = JSON.parse(task.stdout);
  assert.equal(taskPayload.status, 0);
  assert.match(taskPayload.rawOutput, /Handled the requested task/);
  assert.match(taskPayload.rawOutput, /requested task\.\n\nValidation completed\./);
  assert.match(taskPayload.threadId, /^[0-9a-f-]{36}$/i);
  assert.equal(taskPayload.metrics.totalTokens, 220);
  assert.equal(taskPayload.metrics.cachedInputTokens, 80);
  const grokInvocations = fs
    .readFileSync(traceFile, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(grokInvocations.length, 1);
  const promptFileIndex = grokInvocations[0].indexOf("--prompt-file");
  assert.notEqual(promptFileIndex, -1);
  assert.equal(grokInvocations[0].includes("-p"), false);
  assert.equal(fs.existsSync(grokInvocations[0][promptFileIndex + 1]), false);

  const runs = runBridge(repo, ["runs", "--cwd", repo, "--json"]);
  assert.equal(runs.status, 0, runs.stderr);
  const runsPayload = JSON.parse(runs.stdout);
  assert.equal(runsPayload.latestFinished.status, "completed");

  const show = runBridge(repo, ["show", "--cwd", repo, "--json"]);
  assert.equal(show.status, 0, show.stderr);
  const showPayload = JSON.parse(show.stdout);
  assert.match(JSON.stringify(showPayload), /Handled the requested task/);
});

test("background follower streams compact progress and terminal metrics", () => {
  const repo = makeRepo();
  const task = runBridge(
    repo,
    [
      "run",
      "--write",
      "--fresh",
      "--background",
      "--follow",
      "--stream",
      "--cwd",
      repo,
      "--prompt-file",
      ".ai-collab/task.md",
      "--poll-interval-ms",
      "25",
      "--heartbeat-ms",
      "50"
    ],
    { FAKE_GROK_DELAY_MS: "150" }
  );
  assert.equal(task.status, 0, task.stderr);
  assert.doesNotMatch(task.stdout, /private fake thought/);

  const events = parseJsonLines(task.stdout);
  assert.equal(events[0].type, "job.started");
  assert.equal(
    events.filter((event) => event.type === "job.progress" && event.status === "queued").length,
    0
  );
  assert.ok(events.some((event) => event.type === "job.progress"));
  assert.ok(events.some((event) => /Handled the requested task/.test(event.progress ?? "")));
  const completed = events.at(-1);
  assert.equal(completed.type, "job.completed");
  assert.equal(completed.status, "completed");
  assert.equal(completed.metrics.totalTokens, 220);
  assert.equal(completed.watcherDetachedSafe, true);
});

test("long streamed text does not emit a detached tail fragment", () => {
  const repo = makeRepo();
  const task = runBridge(
    repo,
    [
      "run",
      "--write",
      "--fresh",
      "--background",
      "--follow",
      "--stream",
      "--cwd",
      repo,
      "--prompt-file",
      ".ai-collab/task.md",
      "--poll-interval-ms",
      "25"
    ],
    { FAKE_GROK_LONG_TEXT: "1" }
  );
  assert.equal(task.status, 0, task.stderr);
  const events = parseJsonLines(task.stdout);
  const visibleProgress = events
    .map((event) => event.progress)
    .filter((progress) => progress?.startsWith("Grok:"));
  assert.ok(visibleProgress.some((progress) => progress.endsWith("...")));
  assert.ok(visibleProgress.every((progress) => progress !== "Grok: tail."));
  assert.ok(events.every((event) => !event.progress || event.progress.length <= 320));
  assert.ok(events.at(-1).summary.length <= 240);
});

test("stream error events fail even when the Grok process exits zero", () => {
  const repo = makeRepo();
  const task = runBridge(
    repo,
    [
      "run",
      "--write",
      "--fresh",
      "--cwd",
      repo,
      "--prompt-file",
      ".ai-collab/task.md",
      "--json"
    ],
    { FAKE_GROK_STREAM_ERROR: "1" }
  );
  assert.equal(task.status, 1, task.stderr);
  const payload = JSON.parse(task.stdout);
  assert.equal(payload.status, 1);
  assert.match(payload.rawOutput, /fake stream failure/);
  assert.match(payload.errorMessage, /fake stream failure/);
});

test("following a failed background run returns a nonzero exit status", () => {
  const repo = makeRepo();
  const launched = runBridge(
    repo,
    [
      "run",
      "--write",
      "--fresh",
      "--background",
      "--cwd",
      repo,
      "--prompt-file",
      ".ai-collab/task.md",
      "--json"
    ],
    { FAKE_GROK_STREAM_ERROR: "1" }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  const followed = runBridge(repo, [
    "runs",
    jobId,
    "--follow",
    "--stream",
    "--cwd",
    repo,
    "--poll-interval-ms",
    "25"
  ]);
  assert.equal(followed.status, 1, followed.stderr);
  const events = parseJsonLines(followed.stdout);
  assert.equal(events.at(-1).type, "job.failed");
  assert.match(events.at(-1).errorMessage, /fake stream failure/);
});

test("missing Grok binary fails through the tracked follower without a preflight probe", () => {
  const repo = makeRepo();
  const missingBinary = path.join(repo, "missing-grok-binary");
  const task = runBridge(
    repo,
    [
      "run",
      "--write",
      "--fresh",
      "--background",
      "--follow",
      "--stream",
      "--cwd",
      repo,
      "--prompt-file",
      ".ai-collab/task.md",
      "--poll-interval-ms",
      "25"
    ],
    {
      GROK_BINARY: missingBinary,
      GROK_BINARY_ARGS_JSON: "[]"
    }
  );
  assert.equal(task.status, 1, task.stderr);
  const events = parseJsonLines(task.stdout);
  assert.equal(events[0].type, "job.started");
  assert.equal(events.at(-1).type, "job.failed");
  assert.match(events.at(-1).errorMessage, /ENOENT|not found|spawn/i);
});

test("follower timeout leaves the detached Grok worker running", () => {
  const repo = makeRepo();
  const task = runBridge(
    repo,
    [
      "run",
      "--write",
      "--fresh",
      "--background",
      "--follow",
      "--stream",
      "--cwd",
      repo,
      "--prompt-file",
      ".ai-collab/task.md",
      "--timeout-ms",
      "25",
      "--poll-interval-ms",
      "25"
    ],
    { FAKE_GROK_DELAY_MS: "200" }
  );
  assert.equal(task.status, 0, task.stderr);
  const events = parseJsonLines(task.stdout);
  assert.equal(events.at(-1).type, "job.timeout");
  const jobId = events[0].jobId;

  const reconnected = runBridge(repo, [
    "runs",
    jobId,
    "--follow",
    "--stream",
    "--cwd",
    repo,
    "--timeout-ms",
    "3000",
    "--poll-interval-ms",
    "25"
  ]);
  assert.equal(reconnected.status, 0, reconnected.stderr);
  const reconnectedEvents = parseJsonLines(reconnected.stdout);
  assert.equal(reconnectedEvents.at(-1).type, "job.completed");
  assert.equal(reconnectedEvents.at(-1).status, "completed");
});

test("resume candidate uses the current Codex thread ownership", () => {
  const repo = makeRepo();
  const task = runBridge(repo, ["run", "--write", "--cwd", repo, "first task", "--json"]);
  assert.equal(task.status, 0, task.stderr);

  const candidate = runBridge(repo, ["run-resume-candidate", "--cwd", repo, "--json"]);
  assert.equal(candidate.status, 0, candidate.stderr);
  const payload = JSON.parse(candidate.stdout);
  assert.equal(payload.available, true);
  assert.match(payload.candidate.threadId, /^[0-9a-f-]{36}$/i);
});

test("Codex transcript import uses the current thread JSONL", () => {
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-to-grok-home-"));
  const sessions = path.join(home, ".codex", "sessions", "2026", "07", "16");
  fs.mkdirSync(sessions, { recursive: true });
  const threadId = "019f0000-1111-7222-8333-444444444444";
  const transcript = path.join(sessions, `rollout-${threadId}.jsonl`);
  fs.writeFileSync(transcript, '{"type":"user","text":"hello"}\n');

  const result = runBridge(repo, ["import", "--cwd", repo, "--json"], {
    HOME: home,
    USERPROFILE: home,
    CODEX_THREAD_ID: threadId
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sourcePath, fs.realpathSync(transcript));
  assert.equal(payload.threadId, "11111111-2222-4333-8444-555555555555");
  assert.equal(payload.resumeCommand, "grok -r 11111111-2222-4333-8444-555555555555");
});
