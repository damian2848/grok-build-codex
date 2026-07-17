import path from "node:path";

import { ensureGitRepository } from "./git.mjs";

const workspaceRootCache = new Map();

export function resolveWorkspaceRoot(cwd, options = {}) {
  const candidate = path.resolve(cwd);
  const cache = options.cache ?? workspaceRootCache;
  const cached = cache.get(candidate);
  if (cached) {
    return cached;
  }

  const resolveGitRoot = options.resolveGitRoot ?? ensureGitRepository;
  let workspaceRoot;
  try {
    workspaceRoot = path.resolve(resolveGitRoot(candidate));
  } catch {
    workspaceRoot = candidate;
  }

  cache.set(candidate, workspaceRoot);
  cache.set(workspaceRoot, workspaceRoot);
  return workspaceRoot;
}
