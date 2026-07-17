#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.join(scriptDir, "..", "assets", "workspace");
const templates = [
  ".gitignore",
  "context.md",
  "plan.md",
  "task.md",
  "acceptance.md",
  "review.md",
  "state.json"
];

function usage() {
  process.stdout.write(`Usage: init-workspace.mjs [--workspace PATH] [--collab-dir PATH]\n\n`);
  process.stdout.write("Create missing Codex-Grok collaboration files without overwriting existing files.\n");
}

function readValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function parseArgs(argv) {
  let workspace = process.cwd();
  let collabDir = ".ai-collab";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workspace") {
      workspace = readValue(argv, index, argument);
      index += 1;
    } else if (argument === "--collab-dir") {
      collabDir = readValue(argv, index, argument);
      index += 1;
    } else if (argument === "-h" || argument === "--help") {
      return { help: true, workspace, collabDir };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return { help: false, workspace, collabDir };
}

export function initializeWorkspace(options = {}) {
  const workspace = fs.realpathSync(path.resolve(options.workspace ?? process.cwd()));
  const collabDir = options.collabDir ?? ".ai-collab";
  const targetDir = path.isAbsolute(collabDir)
    ? path.normalize(collabDir)
    : path.join(workspace, collabDir);

  fs.mkdirSync(path.join(targetDir, "runs"), { recursive: true });

  const created = [];
  for (const template of templates) {
    const sourceFile = path.join(templateDir, template);
    const targetFile = path.join(targetDir, template);
    if (!fs.existsSync(sourceFile)) {
      throw new Error(`Missing template: ${sourceFile}`);
    }
    if (!fs.existsSync(targetFile)) {
      fs.copyFileSync(sourceFile, targetFile, fs.constants.COPYFILE_EXCL);
      created.push(targetFile);
    }
  }

  return { workspace, targetDir, created };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const result = initializeWorkspace({
    workspace: options.workspace,
    collabDir: options.collabDir
  });
  for (const filePath of result.created) {
    process.stdout.write(`Created ${filePath}\n`);
  }
  process.stdout.write(`Collaboration workspace ready: ${result.targetDir}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
