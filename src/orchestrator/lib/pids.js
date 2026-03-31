/**
 * Process tracking for spawned Claude CLI subprocesses.
 * Writes PIDs to a shared file so `agent-outbound kill` can clean them up.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const PID_DIR = join(homedir(), '.agent-outbound');
const PID_FILE = join(PID_DIR, 'pids.json');

const ensureDir = () => mkdirSync(PID_DIR, { recursive: true });

const readPids = () => {
  try {
    if (!existsSync(PID_FILE)) return [];
    return JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch {
    return [];
  }
};

const writePids = (pids) => {
  ensureDir();
  writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
};

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Register a spawned process PID.
 */
export const trackPid = (pid) => {
  const pids = readPids().filter((entry) => isAlive(entry.pid));
  pids.push({ pid, started: new Date().toISOString(), parent: process.pid });
  writePids(pids);
};

/**
 * Unregister a process PID (it exited normally).
 */
export const untrackPid = (pid) => {
  const pids = readPids().filter((entry) => entry.pid !== pid);
  writePids(pids);
};

/**
 * Get all tracked PIDs that are still alive.
 */
export const getTrackedPids = () => {
  const pids = readPids();
  const alive = pids.filter((entry) => isAlive(entry.pid));
  if (alive.length !== pids.length) writePids(alive);
  return alive;
};

/**
 * Kill all tracked processes.
 */
export const killAll = () => {
  const pids = readPids();
  const results = [];
  for (const entry of pids) {
    try {
      process.kill(entry.pid, 'SIGTERM');
      results.push({ pid: entry.pid, status: 'killed' });
    } catch (err) {
      results.push({ pid: entry.pid, status: err.code === 'ESRCH' ? 'already_dead' : `error: ${err.code}` });
    }
  }
  writePids([]);
  return results;
};
