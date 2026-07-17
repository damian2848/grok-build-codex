import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  const task = runBridge(repo, [
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
  ]);
  assert.equal(task.status, 0, task.stderr);
  const taskPayload = JSON.parse(task.stdout);
  assert.equal(taskPayload.status, 0);
  assert.match(taskPayload.rawOutput, /Handled the requested task/);
  assert.match(taskPayload.threadId, /^[0-9a-f-]{36}$/i);

  const runs = runBridge(repo, ["runs", "--cwd", repo, "--json"]);
  assert.equal(runs.status, 0, runs.stderr);
  const runsPayload = JSON.parse(runs.stdout);
  assert.equal(runsPayload.latestFinished.status, "completed");

  const show = runBridge(repo, ["show", "--cwd", repo, "--json"]);
  assert.equal(show.status, 0, show.stderr);
  const showPayload = JSON.parse(show.stdout);
  assert.match(JSON.stringify(showPayload), /Handled the requested task/);
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
