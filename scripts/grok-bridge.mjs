#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { main as runUpstreamBridge } from "./upstream/scripts/grok-bridge.mjs";
import { runImport as importGrokSession } from "./upstream/scripts/lib/grok.mjs";
import { resolveWorkspaceRoot } from "./upstream/scripts/lib/workspace.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const upstreamBridge = path.join(scriptDir, "upstream", "scripts", "grok-bridge.mjs");
const CODEX_THREAD_ENV = "CODEX_THREAD_ID";
const CODEX_TRANSCRIPT_ENV = "CODEX_TRANSCRIPT_PATH";
const DATA_ENV = "GROK_CODEX_DATA";

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

function resolveCommandCwd(argv) {
  const value = readOption(argv, "--cwd");
  return value ? path.resolve(process.cwd(), value) : process.cwd();
}

function walkForTranscript(root, threadId) {
  if (!root || !threadId || !fs.existsSync(root)) {
    return null;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) {
        return entryPath;
      }
    }
  }
  return null;
}

function allowedTranscriptRoots() {
  return [
    path.join(os.homedir(), ".codex", "sessions"),
    path.join(os.homedir(), ".codex", "archived_sessions")
  ];
}

function isWithinRoot(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveTranscript(argv, cwd) {
  const requested = readOption(argv, "--source") || process.env[CODEX_TRANSCRIPT_ENV];
  const roots = allowedTranscriptRoots();
  let candidate = requested ? path.resolve(cwd, requested) : null;

  if (!candidate) {
    const threadId = process.env[CODEX_THREAD_ENV];
    for (const root of roots) {
      candidate = walkForTranscript(root, threadId);
      if (candidate) {
        break;
      }
    }
  }

  if (!candidate || !fs.existsSync(candidate)) {
    throw new Error(
      "Could not locate the current Codex transcript. Pass --source <path-to-codex-jsonl>."
    );
  }

  const realCandidate = fs.realpathSync(candidate);
  const allowed = roots.some((root) => {
    if (!fs.existsSync(root)) {
      return false;
    }
    return isWithinRoot(realCandidate, fs.realpathSync(root));
  });
  if (!allowed) {
    throw new Error(`Codex transcript must be under ~/.codex/sessions or ~/.codex/archived_sessions: ${realCandidate}`);
  }
  if (path.extname(realCandidate) !== ".jsonl") {
    throw new Error(`Codex transcript must be a JSONL file: ${realCandidate}`);
  }
  return realCandidate;
}

function runImport(argv, env, cwd) {
  const sourcePath = resolveTranscript(argv, cwd);
  const result = importGrokSession(cwd, { sourcePath, env });
  const rawOutput = result.stdout;
  const sessionId = result.threadId;
  const payload = {
    sourcePath,
    threadId: sessionId,
    sessionId,
    resumeCommand: result.resumeCommand ?? (sessionId ? `grok -r ${sessionId}` : null),
    stdout: rawOutput
  };

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write("Imported the current Codex session into Grok.\n");
    process.stdout.write(`Source: ${sourcePath}\n`);
    process.stdout.write(sessionId ? `Resume in Grok: grok -r ${sessionId}\n` : "Grok session ID was not detected.\n");
  }
}

function restoreEnvironmentValue(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function dispatchUpstream(argv, env) {
  const previousArgv = process.argv;
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const previousSessionId = process.env.GROK_CC_SESSION_ID;
  process.argv = [process.execPath, upstreamBridge, ...argv];
  process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
  restoreEnvironmentValue("GROK_CC_SESSION_ID", env.GROK_CC_SESSION_ID);

  try {
    await runUpstreamBridge();
  } finally {
    process.argv = previousArgv;
    restoreEnvironmentValue("CLAUDE_PLUGIN_DATA", previousPluginData);
    restoreEnvironmentValue("GROK_CC_SESSION_ID", previousSessionId);
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const aliasMap = new Map([
    ["delegate", "run"],
    ["status", "runs"],
    ["cancel", "stop"]
  ]);
  const subcommand = aliasMap.get(rawArgs[0]) ?? rawArgs[0];
  const argv = subcommand ? [subcommand, ...rawArgs.slice(1)] : rawArgs;
  const cwd = resolveCommandCwd(argv);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA:
      process.env[DATA_ENV] || path.join(workspaceRoot, ".ai-collab", ".bridge-data")
  };

  if (process.env[CODEX_THREAD_ENV]) {
    env.GROK_CC_SESSION_ID = process.env[CODEX_THREAD_ENV];
  }

  if (subcommand === "import") {
    runImport(argv.slice(1), env, cwd);
    return;
  }

  await dispatchUpstream(argv, env);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { main };
