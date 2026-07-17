import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "grok-cc-runs");
const STATE_FILE_NAME = "state.json";
const LOCK_FILE_NAME = "state.json.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const LOCK_MAX_ATTEMPTS = 100;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 30000;
const MAX_INDEX_SUMMARY_LENGTH = 240;
const MAX_INDEX_ERROR_LENGTH = 1000;
const JOB_INDEX_FIELDS = [
  "id",
  "kind",
  "kindLabel",
  "title",
  "workspaceRoot",
  "jobClass",
  "summary",
  "write",
  "sessionId",
  "status",
  "phase",
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "cancelledAt",
  "threadId",
  "turnId",
  "pid",
  "agentPid",
  "bridgePid",
  "companionPid",
  "logFile",
  "errorMessage"
];
const stateDirCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) {
    return;
  }
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, duration);
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {},
    jobs: []
  };
}

function resolveBridgePidField(existing = {}, patch = {}) {
  if (patch.bridgePid !== undefined) {
    return patch.bridgePid;
  }
  if (patch.companionPid !== undefined) {
    return patch.companionPid;
  }
  return existing.bridgePid ?? existing.companionPid ?? null;
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  const cacheKey = `${stateRoot}\0${workspaceRoot}`;
  const cached = stateDirCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const stateDir = path.join(stateRoot, `${slug}-${hash}`);
  stateDirCache.set(cacheKey, stateDir);
  return stateDir;
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveStateLockFile(cwd) {
  return path.join(resolveStateDir(cwd), LOCK_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function replaceFileAtomic(tempPath, filePath, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const platform = options.platform ?? process.platform;
  try {
    fsImpl.renameSync(tempPath, filePath);
  } catch (error) {
    if (platform !== "win32" || !["EEXIST", "EPERM", "EACCES"].includes(error?.code)) {
      throw error;
    }
    fsImpl.rmSync(filePath, { force: true });
    fsImpl.renameSync(tempPath, filePath);
  }
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  try {
    fs.writeFileSync(tempPath, content, "utf8");
    replaceFileAtomic(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
    }
    throw error;
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM" || error?.code === "EACCES";
  }
}

function readLockSnapshot(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    const raw = fs.readFileSync(lockPath, "utf8");
    let metadata = null;
    try {
      metadata = JSON.parse(raw);
    } catch {
    }
    return { stat, raw, metadata };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function recoverStaleLock(lockPath) {
  const first = readLockSnapshot(lockPath);
  if (!first) {
    return true;
  }

  const ownerPid = Number(first.metadata?.pid);
  const ageMs = Math.max(0, Date.now() - first.stat.mtimeMs);
  const ownerExited = Number.isInteger(ownerPid) && ownerPid > 0 && !processExists(ownerPid);
  if (!ownerExited && ageMs < LOCK_STALE_MS) {
    return false;
  }

  const current = readLockSnapshot(lockPath);
  if (!current) {
    return true;
  }
  if (
    current.raw !== first.raw ||
    current.stat.mtimeMs !== first.stat.mtimeMs ||
    current.stat.size !== first.stat.size
  ) {
    return false;
  }

  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    return false;
  }
}

function releaseOwnedLock(lockPath, token) {
  const snapshot = readLockSnapshot(lockPath);
  if (!snapshot || snapshot.metadata?.token !== token) {
    return;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
  }
}

export function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockPath = resolveStateLockFile(cwd);

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    let fd = null;
    let metadataWritten = false;
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error?.code === "EEXIST") {
        if (recoverStaleLock(lockPath)) {
          continue;
        }
        sleepMs(LOCK_RETRY_MS);
        continue;
      }
      throw error;
    }

    try {
      fs.writeFileSync(
        fd,
        `${JSON.stringify({ pid: process.pid, token, createdAt: nowIso() })}\n`,
        "utf8"
      );
      metadataWritten = true;
      return fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
      }
      if (metadataWritten) {
        releaseOwnedLock(lockPath, token);
      } else {
        try {
          fs.unlinkSync(lockPath);
        } catch {
        }
      }
    }
  }

  throw new Error(`Timed out acquiring state lock at ${lockPath}`);
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isTerminalJobStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function readJobFileIfPresent(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  try {
    return readJobFile(jobFile);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function writeJobFileUnlocked(cwd, jobId, payload) {
  ensureStateDir(cwd);
  writeFileAtomic(resolveJobFile(cwd, jobId), `${JSON.stringify(payload, null, 2)}\n`);
}

function compactIndexText(value, limit) {
  if (value == null) {
    return value;
  }
  const normalized = String(value).trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function projectJobForIndex(job) {
  const projected = {};
  for (const field of JOB_INDEX_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(job, field) && job[field] !== undefined) {
      projected[field] = job[field];
    }
  }
  if (Object.prototype.hasOwnProperty.call(projected, "summary")) {
    projected.summary = compactIndexText(projected.summary, MAX_INDEX_SUMMARY_LENGTH);
  }
  if (Object.prototype.hasOwnProperty.call(projected, "errorMessage")) {
    projected.errorMessage = compactIndexText(projected.errorMessage, MAX_INDEX_ERROR_LENGTH);
  }
  return projected;
}

function upsertJobInState(state, jobPatch) {
  const timestamp = nowIso();
  const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
  if (existingIndex === -1) {
    state.jobs.unshift(projectJobForIndex({
      createdAt: timestamp,
      updatedAt: timestamp,
      ...jobPatch
    }));
    return;
  }
  state.jobs[existingIndex] = projectJobForIndex({
    ...state.jobs[existingIndex],
    ...jobPatch,
    updatedAt: timestamp
  });
}

function jobsConflict(existing, candidate) {
  const active = existing.status === "queued" || existing.status === "running";
  return active && (Boolean(existing.write) || Boolean(candidate.write));
}

export function reserveJob(cwd, job) {
  if (!job?.id) {
    throw new Error("reserveJob requires a job id.");
  }

  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const existing = state.jobs.find((entry) => entry.id === job.id) ?? null;
    if (existing) {
      return { reserved: false, reason: "duplicate", conflict: existing, job: existing };
    }

    const conflict = state.jobs.find((entry) => jobsConflict(entry, job)) ?? null;
    if (conflict) {
      return { reserved: false, reason: "active-conflict", conflict, job: null };
    }

    const timestamp = nowIso();
    const reservedJob = {
      ...job,
      createdAt: job.createdAt ?? timestamp,
      updatedAt: timestamp,
      status: "queued",
      phase: "queued"
    };
    writeJobFileUnlocked(cwd, job.id, reservedJob);
    upsertJobInState(state, reservedJob);
    try {
      saveStateUnlocked(cwd, state);
    } catch (error) {
      try {
        removeJobFile(resolveJobFile(cwd, job.id));
      } catch {
      }
      throw error;
    }
    return { reserved: true, reason: "reserved", conflict: null, job: reservedJob };
  });
}

/** Claim terminal status for job file + index under one lock. cancelled wins. */
export function claimJobTerminal(cwd, jobId, nextStatus, patch = {}) {
  if (!isTerminalJobStatus(nextStatus)) {
    throw new Error(`claimJobTerminal requires a terminal status, got: ${nextStatus}`);
  }

  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const existingFile = readJobFileIfPresent(cwd, jobId);
    const indexJob = state.jobs.find((job) => job.id === jobId) ?? null;
    const existing = existingFile ?? indexJob;

    if (!existing) {
      return { claimed: false, status: null, job: null, reason: "missing" };
    }

    const currentStatus = existing.status;
    if (isTerminalJobStatus(currentStatus)) {
      if (currentStatus === "cancelled" && nextStatus !== "cancelled") {
        return { claimed: false, status: "cancelled", job: existing, reason: "cancelled-wins" };
      }
      if (nextStatus === "cancelled" && currentStatus !== "cancelled") {
        return { claimed: false, status: currentStatus, job: existing, reason: "already-terminal" };
      }
      if (currentStatus === "cancelled" && nextStatus === "cancelled") {
        const merged = {
          ...existing,
          ...patch,
          id: jobId,
          status: "cancelled",
          phase: "cancelled",
          pid: null,
          agentPid: null,
          updatedAt: nowIso()
        };
        writeJobFileUnlocked(cwd, jobId, merged);
        upsertJobInState(state, {
          id: jobId,
          status: "cancelled",
          phase: "cancelled",
          summary: merged.summary ?? existing.summary,
          threadId: merged.threadId ?? existing.threadId ?? null,
          pid: null,
          agentPid: null,
          errorMessage: merged.errorMessage ?? existing.errorMessage
        });
        saveStateUnlocked(cwd, state);
        return { claimed: false, status: "cancelled", job: merged, reason: "cancelled-merge" };
      }
      return { claimed: false, status: currentStatus, job: existing, reason: "already-terminal" };
    }

    const completedAt = patch.completedAt ?? nowIso();
    const nextJob = {
      ...existing,
      ...patch,
      id: jobId,
      status: nextStatus,
      phase: patch.phase ?? (nextStatus === "completed" ? "done" : nextStatus),
      pid: patch.pid === undefined ? null : patch.pid,
      agentPid: patch.agentPid === undefined ? null : patch.agentPid,
      bridgePid: resolveBridgePidField(existing, patch),
      completedAt,
      updatedAt: nowIso()
    };
    if (nextStatus === "cancelled") {
      nextJob.cancelledAt = patch.cancelledAt ?? completedAt;
    }

    writeJobFileUnlocked(cwd, jobId, nextJob);
    upsertJobInState(state, {
      id: jobId,
      status: nextStatus,
      phase: nextJob.phase,
      summary: nextJob.summary ?? existing.summary,
      threadId: nextJob.threadId ?? existing.threadId ?? null,
      turnId: nextJob.turnId ?? existing.turnId ?? null,
      pid: null,
      agentPid: null,
      bridgePid: nextJob.bridgePid ?? null,
      errorMessage: nextJob.errorMessage,
      completedAt,
      logFile: nextJob.logFile ?? existing.logFile ?? null,
      sessionId: nextJob.sessionId ?? existing.sessionId,
      kind: nextJob.kind ?? existing.kind,
      kindLabel: nextJob.kindLabel ?? existing.kindLabel,
      title: nextJob.title ?? existing.title,
      jobClass: nextJob.jobClass ?? existing.jobClass,
      write: nextJob.write ?? existing.write
    });
    saveStateUnlocked(cwd, state);
    return { claimed: true, status: nextStatus, job: nextJob, reason: "claimed" };
  });
}

/** Patch non-terminal job under lock; no-op if missing/terminal. */
export function patchJobIfActive(cwd, jobId, patch = {}) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const existingFile = readJobFileIfPresent(cwd, jobId);
    const indexJob = state.jobs.find((job) => job.id === jobId) ?? null;
    const existing = existingFile ?? indexJob;
    if (!existing) {
      return { patched: false, status: null, job: null, reason: "missing" };
    }
    if (isTerminalJobStatus(existing.status)) {
      return { patched: false, status: existing.status, job: existing, reason: "terminal" };
    }

    const bridgePid = resolveBridgePidField(existing, patch);
    const nextJob = {
      ...existing,
      ...patch,
      id: jobId,
      bridgePid,
      agentPid: patch.agentPid !== undefined ? patch.agentPid : (existing.agentPid ?? null),
      pid:
        patch.pid !== undefined
          ? patch.pid
          : (bridgePid ?? existing.pid ?? null),
      updatedAt: nowIso()
    };

    writeJobFileUnlocked(cwd, jobId, nextJob);
    upsertJobInState(state, {
      id: jobId,
      status: nextJob.status,
      phase: nextJob.phase,
      summary: nextJob.summary,
      threadId: nextJob.threadId,
      turnId: nextJob.turnId,
      pid: nextJob.pid,
      agentPid: nextJob.agentPid,
      bridgePid: nextJob.bridgePid,
      logFile: nextJob.logFile,
      errorMessage: nextJob.errorMessage
    });
    saveStateUnlocked(cwd, state);
    return { patched: true, status: nextJob.status, job: nextJob, reason: "patched" };
  });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  let raw = "";
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    throw new Error(`Failed to read bridge state file ${stateFile}: ${error.message}`);
  }

  if (!raw.trim()) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch (error) {
    const quarantinePath = `${stateFile}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(stateFile, quarantinePath);
    } catch {
    }
    throw new Error(
      `Bridge state file is corrupt and was quarantined${quarantinePath ? ` to ${quarantinePath}` : ""}: ${error.message}`
    );
  }
}

function pruneJobs(jobs) {
  const sorted = [...jobs]
    .map(projectJobForIndex)
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  const active = sorted.filter((job) => job.status === "queued" || job.status === "running");
  const terminalSlots = Math.max(0, MAX_JOBS - active.length);
  const retainedIds = new Set([
    ...active.map((job) => job.id),
    ...sorted
      .filter((job) => job.status !== "queued" && job.status !== "running")
      .slice(0, terminalSlots)
      .map((job) => job.id)
  ]);
  return sorted.filter((job) => retainedIds.has(job.id));
}

function removeFileIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
  }
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeFileIfExists(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
