#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const upstreamBridge = path.join(scriptDir, "upstream", "scripts", "grok-bridge.mjs");
const CODEX_THREAD_ENV = "CODEX_THREAD_ID";
const CODEX_TRANSCRIPT_ENV = "CODEX_TRANSCRIPT_PATH";
const DATA_ENV = "GROK_CODEX_DATA";
const GROK_BINARY_ARGS_ENV = "GROK_BINARY_ARGS_JSON";

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

function resolveWorkspaceRoot(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status === 0 && result.stdout.trim()) {
    return path.resolve(result.stdout.trim());
  }
  return path.resolve(cwd);
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

function parseSessionId(raw) {
  for (const line of String(raw ?? "").split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      const sessionId =
        parsed.sessionId ?? parsed.session_id ?? parsed.id ?? parsed.importedSessionId ?? parsed.threadId;
      if (sessionId) {
        return String(sessionId);
      }
    } catch {
    }
  }

  const match = String(raw ?? "").match(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
  );
  return match?.[0] ?? null;
}

function resolveGrokBinaryArgs(env) {
  const raw = env[GROK_BINARY_ARGS_ENV];
  if (!raw || !String(raw).trim()) {
    return [];
  }
  const parsed = JSON.parse(String(raw));
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(`${GROK_BINARY_ARGS_ENV} must be a JSON array of strings.`);
  }
  return parsed;
}

function runImport(argv, env, cwd) {
  const sourcePath = resolveTranscript(argv, cwd);
  const grokBinary = env.GROK_BINARY || "grok";
  const result = spawnSync(grokBinary, [...resolveGrokBinaryArgs(env), "import", sourcePath, "--json"], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `grok import exited ${result.status}`).trim());
  }

  const rawOutput = result.stdout.trim();
  const sessionId = parseSessionId(rawOutput);
  const payload = {
    sourcePath,
    threadId: sessionId,
    sessionId,
    resumeCommand: sessionId ? `grok -r ${sessionId}` : null,
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

function main() {
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

  const result = spawnSync(process.execPath, [upstreamBridge, ...argv], {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true
  });

  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? (result.signal ? 1 : 0);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
