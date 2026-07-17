#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
if (process.env.FAKE_GROK_TRACE_FILE) {
  fs.appendFileSync(process.env.FAKE_GROK_TRACE_FILE, `${JSON.stringify(args)}\n`, "utf8");
}
const first = args[0];
const hasFlag = (flag) => args.includes(flag);
const readFlagValue = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
};

if (["version", "--version", "-V"].includes(first)) {
  process.stdout.write("grok 0.2.101-fake\n");
} else if (first === "models") {
  process.stdout.write("You are logged in.\nDefault model: sub2api-grok\n");
} else if (first === "import") {
  process.stdout.write('{"sessionId":"11111111-2222-4333-8444-555555555555","status":"imported"}\n');
} else if (hasFlag("-p") || hasFlag("--prompt-file") || hasFlag("-r") || hasFlag("--resume") || hasFlag("-c")) {
  if (readFlagValue("--output-format") === "streaming-json") {
    process.stdout.write(`${JSON.stringify({ type: "thought", data: "private fake thought" })}\n`);
    if (process.env.FAKE_GROK_STREAM_ERROR === "1") {
      await new Promise((resolve) => {
        process.stdout.write(
          `${JSON.stringify({ type: "error", message: "fake stream failure" })}\n`,
          resolve
        );
      });
      process.exit(0);
    }
    const longText = `${"Long progress without a boundary ".repeat(8)}tail.`;
    const initialText = process.env.FAKE_GROK_LONG_TEXT === "1"
      ? longText
      : "Handled the requested task.";
    process.stdout.write(`${JSON.stringify({ type: "text", data: initialText })}\n`);
    const delayMs = Number(
      process.env.FAKE_GROK_DELAY_MS ?? (process.env.FAKE_GROK_LONG_TEXT === "1" ? 150 : 0)
    );
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    process.stdout.write(`${JSON.stringify({ type: "text", data: "Validation completed." })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId: readFlagValue("--session-id") ?? readFlagValue("-r"),
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 80,
        output_tokens: 20,
        reasoning_tokens: 5,
        total_tokens: 220
      },
      modelUsage: {
        "sub2api-grok": {
          modelCalls: 2,
          apiDurationMs: 40
        }
      },
      total_cost_usd: 0.001,
      total_cost_usd_ticks: 10000000,
      num_turns: 2
    })}\n`);
  } else {
    process.stdout.write("Handled the requested task.\n");
  }
} else {
  process.stderr.write(`fake grok: unknown invocation: ${args.join(" ")}\n`);
  process.exitCode = 1;
}
