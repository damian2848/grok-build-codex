import assert from "node:assert/strict";
import test from "node:test";

import { runCommand, terminateProcessTree } from "../scripts/upstream/scripts/lib/process.mjs";
import { replaceFileAtomic } from "../scripts/upstream/scripts/lib/state.mjs";

test("Windows command execution uses the native command shell", () => {
  let capturedOptions = null;
  const result = runCommand("grok", ["models"], {
    platform: "win32",
    spawnSyncImpl(command, args, options) {
      assert.equal(command, "grok");
      assert.deepEqual(args, ["models"]);
      capturedOptions = options;
      return { status: 0, stdout: "ok", stderr: "", signal: null };
    }
  });

  assert.equal(result.status, 0);
  assert.equal(capturedOptions.shell, true);
  assert.equal(capturedOptions.windowsHide, true);
});

test("Windows cancellation terminates the full process tree with taskkill", () => {
  let invocation = null;
  const result = terminateProcessTree(4321, {
    platform: "win32",
    runCommandImpl(command, args) {
      invocation = { command, args };
      return { status: 0, stdout: "SUCCESS", stderr: "", signal: null, error: null };
    }
  });

  assert.deepEqual(invocation, {
    command: "taskkill",
    args: ["/PID", "4321", "/T", "/F"]
  });
  assert.equal(result.delivered, true);
  assert.equal(result.method, "taskkill");
});

test("process-tree cancellation rejects non-positive PIDs", () => {
  let called = false;
  const result = terminateProcessTree(0, {
    platform: "win32",
    runCommandImpl() {
      called = true;
      return { status: 0, stdout: "", stderr: "", signal: null, error: null };
    }
  });
  assert.equal(result.attempted, false);
  assert.equal(called, false);
});

test("Windows state replacement removes an existing destination before retrying", () => {
  const operations = [];
  let renameAttempts = 0;
  const fsImpl = {
    renameSync(source, destination) {
      operations.push(["rename", source, destination]);
      renameAttempts += 1;
      if (renameAttempts === 1) {
        const error = new Error("destination exists");
        error.code = "EPERM";
        throw error;
      }
    },
    rmSync(destination, options) {
      operations.push(["remove", destination, options]);
    }
  };

  replaceFileAtomic("state.tmp", "state.json", { platform: "win32", fsImpl });
  assert.deepEqual(operations, [
    ["rename", "state.tmp", "state.json"],
    ["remove", "state.json", { force: true }],
    ["rename", "state.tmp", "state.json"]
  ]);
});
