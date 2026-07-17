#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(scriptDir, "grok-bridge.mjs");

function usage() {
  process.stdout.write(`Usage: run-grok.mjs [options]\n\n`);
  process.stdout.write(`Compatibility wrapper around the stateful Node bridge.\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --workspace PATH       Repository path (default: current directory)\n`);
  process.stdout.write(`  --task-file PATH       Prompt file (default: .ai-collab/task.md)\n`);
  process.stdout.write(`  --model MODEL          Optional Grok model or configured alias\n`);
  process.stdout.write(`  --effort LEVEL         Optional low, medium, or high effort\n`);
  process.stdout.write(`  --background           Queue a tracked background run\n`);
  process.stdout.write(`  --follow               Follow a detached run with compact live progress\n`);
  process.stdout.write(`  --stream               Emit follower events as JSONL (requires --follow)\n`);
  process.stdout.write(`  --timeout-ms MS        Stop following after this duration; job keeps running\n`);
  process.stdout.write(`  --poll-interval-ms MS  Follower state refresh interval\n`);
  process.stdout.write(`  --heartbeat-ms MS      Follower heartbeat interval\n`);
  process.stdout.write(`  --resume               Continue the latest tracked Grok thread\n`);
  process.stdout.write(`  --fresh                Force a new Grok thread\n`);
  process.stdout.write(`  --json                 Emit bridge JSON\n`);
  process.stdout.write(`  -h, --help             Show this help\n`);
}

function readValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

export function buildBridgeArgs(argv) {
  let workspace = process.cwd();
  let taskFile = ".ai-collab/task.md";
  let model = null;
  let effort = null;
  let background = false;
  let follow = false;
  let stream = false;
  let timeoutMs = null;
  let pollIntervalMs = null;
  let heartbeatMs = null;
  let resume = false;
  let fresh = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workspace") {
      workspace = readValue(argv, index, argument);
      index += 1;
    } else if (argument === "--task-file") {
      taskFile = readValue(argv, index, argument);
      index += 1;
    } else if (argument === "--model") {
      model = readValue(argv, index, argument);
      index += 1;
    } else if (argument === "--effort") {
      effort = readValue(argv, index, argument);
      index += 1;
    } else if (argument === "--background") {
      background = true;
    } else if (argument === "--follow") {
      follow = true;
    } else if (argument === "--stream") {
      stream = true;
    } else if (argument === "--timeout-ms") {
      timeoutMs = readValue(argv, index, argument);
      index += 1;
    } else if (argument === "--poll-interval-ms") {
      pollIntervalMs = readValue(argv, index, argument);
      index += 1;
    } else if (argument === "--heartbeat-ms") {
      heartbeatMs = readValue(argv, index, argument);
      index += 1;
    } else if (argument === "--resume") {
      resume = true;
    } else if (argument === "--fresh") {
      fresh = true;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "-h" || argument === "--help") {
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (resume && fresh) {
    throw new Error("Choose either --resume or --fresh");
  }

  const bridgeArgs = [
    bridge,
    "run",
    "--write",
    "--cwd",
    path.resolve(workspace),
    "--prompt-file",
    taskFile
  ];
  if (model) bridgeArgs.push("--model", model);
  if (effort) bridgeArgs.push("--effort", effort);
  if (background) bridgeArgs.push("--background");
  if (follow) bridgeArgs.push("--follow");
  if (stream) bridgeArgs.push("--stream");
  if (timeoutMs) bridgeArgs.push("--timeout-ms", timeoutMs);
  if (pollIntervalMs) bridgeArgs.push("--poll-interval-ms", pollIntervalMs);
  if (heartbeatMs) bridgeArgs.push("--heartbeat-ms", heartbeatMs);
  if (resume) bridgeArgs.push("--resume");
  if (fresh) bridgeArgs.push("--fresh");
  if (json) bridgeArgs.push("--json");
  return bridgeArgs;
}

function main() {
  const bridgeArgs = buildBridgeArgs(process.argv.slice(2));
  if (!bridgeArgs) {
    usage();
    return;
  }

  const result = spawnSync(process.execPath, bridgeArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? (result.signal ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
