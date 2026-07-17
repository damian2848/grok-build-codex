import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readJobProgressPreview } from "../scripts/upstream/scripts/lib/job-control.mjs";
import {
  listJobs,
  loadState,
  readJobFile,
  ensureStateDir,
  reserveJob,
  resolveJobFile,
  resolveStateFile,
  resolveStateLockFile,
  saveState,
  withStateLock
} from "../scripts/upstream/scripts/lib/state.mjs";
import { resolveWorkspaceRoot } from "../scripts/upstream/scripts/lib/workspace.mjs";

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grok-state-test-"));
}

test("state lock recovers an abandoned stale lock", () => {
  const workspace = makeWorkspace();
  ensureStateDir(workspace);
  const lockFile = resolveStateLockFile(workspace);
  fs.writeFileSync(lockFile, '{"pid":-1,"token":"abandoned"}\n', "utf8");
  const staleTime = new Date(Date.now() - 60000);
  fs.utimesSync(lockFile, staleTime, staleTime);

  const value = withStateLock(workspace, () => "recovered");
  assert.equal(value, "recovered");
  assert.equal(fs.existsSync(lockFile), false);
});

test("job reservation atomically blocks overlapping write work", () => {
  const workspace = makeWorkspace();
  const first = reserveJob(workspace, {
    id: "write-one",
    status: "queued",
    phase: "queued",
    write: true
  });
  const second = reserveJob(workspace, {
    id: "write-two",
    status: "queued",
    phase: "queued",
    write: true
  });

  assert.equal(first.reserved, true);
  assert.equal(second.reserved, false);
  assert.equal(second.reason, "active-conflict");
  assert.equal(second.conflict.id, "write-one");
});

test("state index excludes full request payloads", () => {
  const workspace = makeWorkspace();
  const sentinel = `private-prompt-${"x".repeat(16 * 1024)}`;
  const reservation = reserveJob(workspace, {
    id: "compact-index",
    kind: "task",
    title: "Compact index",
    summary: "s".repeat(500),
    write: false,
    request: {
      kind: "task",
      prompt: sentinel
    }
  });
  assert.equal(reservation.reserved, true);

  const state = loadState(workspace);
  assert.equal(state.jobs[0].request, undefined);
  assert.ok(state.jobs[0].summary.length <= 240);
  assert.equal(fs.readFileSync(resolveStateFile(workspace), "utf8").includes(sentinel), false);

  const stored = readJobFile(resolveJobFile(workspace, "compact-index"));
  assert.equal(stored.request.prompt, sentinel);
});

test("state pruning retains every active job before terminal history", () => {
  const workspace = makeWorkspace();
  const jobs = [
    {
      id: "active-oldest",
      status: "running",
      phase: "running",
      updatedAt: "2026-07-17T00:00:00.000Z"
    }
  ];
  for (let index = 0; index < 60; index += 1) {
    jobs.push({
      id: `terminal-${index}`,
      status: "completed",
      phase: "done",
      updatedAt: new Date(Date.UTC(2026, 6, 17, 0, 1, index)).toISOString()
    });
  }

  saveState(workspace, { version: 1, config: {}, jobs });
  const retained = listJobs(workspace);
  assert.equal(retained.some((job) => job.id === "active-oldest"), true);
  assert.equal(retained.length, 50);
});

test("workspace root resolution is cached per process", () => {
  const workspace = makeWorkspace();
  const cache = new Map();
  let calls = 0;
  const options = {
    cache,
    resolveGitRoot(candidate) {
      calls += 1;
      return candidate;
    }
  };

  assert.equal(resolveWorkspaceRoot(workspace, options), workspace);
  assert.equal(resolveWorkspaceRoot(workspace, options), workspace);
  assert.equal(calls, 1);
});

test("progress preview reads the tail of large logs", () => {
  const workspace = makeWorkspace();
  const logFile = path.join(workspace, "large.log");
  fs.writeFileSync(
    logFile,
    `${"x".repeat(80 * 1024)}\n[2026-07-17T00:00:00.000Z] Latest progress\n`,
    "utf8"
  );

  assert.deepEqual(readJobProgressPreview(logFile, 1), ["Latest progress"]);
});
