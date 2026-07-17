#!/usr/bin/env node

import process from "node:process";

const args = process.argv.slice(2);
const first = args[0];
const hasFlag = (flag) => args.includes(flag);

if (["version", "--version", "-V"].includes(first)) {
  process.stdout.write("grok 0.2.101-fake\n");
} else if (first === "models") {
  process.stdout.write("You are logged in.\nDefault model: sub2api-grok\n");
} else if (first === "import") {
  process.stdout.write('{"sessionId":"11111111-2222-4333-8444-555555555555","status":"imported"}\n');
} else if (hasFlag("-p") || hasFlag("-r") || hasFlag("--resume") || hasFlag("-c")) {
  process.stdout.write("Handled the requested task.\n");
} else {
  process.stderr.write(`fake grok: unknown invocation: ${args.join(" ")}\n`);
  process.exitCode = 1;
}
