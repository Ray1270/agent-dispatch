import fs from 'node:fs';
import { getAdapter, hasAdapter } from './adapters/index.mjs';
import { parseJsonLines } from './adapters/utils.mjs';

/**
 * Safely check whether a PID is still alive.
 * @param {number | null | undefined} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Parse a run's stdout.jsonl into normalized timeline events for live progress display.
 * Delegates event parsing to the worker's registered adapter.
 * @param {Record<string, any>} meta
 * @param {{ maxEvents?: number }} [options]
 */
export function parseLiveRunProgress(meta, { maxEvents = 200 } = {}) {
  const stdoutFile = meta?.artifacts?.stdoutFile;
  const state = {
    sessionId: meta?.sessionId || null,
    toolCalls: 0,
    eventCount: 0,
    lastEventAt: null,
    latestStep: null,
    usage: meta?.usage || null,
    events: [],
  };

  if (!stdoutFile || !fs.existsSync(stdoutFile)) {
    return state;
  }

  let raw = '';
  try {
    raw = fs.readFileSync(stdoutFile, 'utf8');
    const stat = fs.statSync(stdoutFile);
    state.lastEventAt = stat.mtime.toISOString();
  } catch {
    return state;
  }

  const workerId = String(meta?.worker || 'codex');
  const parser = hasAdapter(workerId) ? getAdapter(workerId).parseEventLine : null;
  if (typeof parser !== 'function') {
    return state;
  }

  const allEvents = [];
  let idx = 0;
  for (const ev of parseJsonLines(raw)) {
    const parsed = parser(ev, state);
    if (parsed) {
      idx += 1;
      allEvents.push({ index: idx, ...parsed });
    }
  }

  state.eventCount = allEvents.length;
  state.latestStep = allEvents.length > 0 ? allEvents[allEvents.length - 1] : null;
  state.events = allEvents.length > maxEvents ? allEvents.slice(-maxEvents) : allEvents;
  return state;
}
