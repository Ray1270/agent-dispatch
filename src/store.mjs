import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Generate a sortable, collision-free run ID.
 * @param {string} worker
 * @param {Date} [now]
 * @returns {string}
 */
export function generateRunId(worker, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const hex = crypto.randomBytes(2).toString('hex');
  return `${datePart}-${timePart}-${worker}-${hex}`;
}

/**
 * Create the artifact directory for a run under <stateDir>/runs/<runId>.
 * @param {string} stateDir
 * @param {string} runId
 * @returns {string}
 */
export function createRunDir(stateDir, runId) {
  const runDir = path.join(stateDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

/**
 * Persist run metadata JSON to <runDir>/meta.json.
 * @param {string} runDir
 * @param {Record<string, any>} meta
 */
export function saveRunMeta(runDir, meta) {
  const metaPath = path.join(runDir, 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return metaPath;
}

/**
 * Load metadata for a previously recorded run ID.
 * @param {string} stateDir
 * @param {string} runId
 * @returns {Record<string, any>}
 */
export function loadRunMeta(stateDir, runId) {
  const metaPath = path.join(stateDir, 'runs', runId, 'meta.json');
  if (!fs.existsSync(metaPath)) {
    throw new Error(`Run not found: ${runId} (expected ${metaPath})`);
  }
  return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

/**
 * List recent runs sorted newest-first.
 * @param {string} stateDir
 * @param {number} [limit]
 * @returns {Record<string, any>[]}
 */
export function listRuns(stateDir, limit = 20) {
  const runsDir = path.join(stateDir, 'runs');
  if (!fs.existsSync(runsDir)) return [];

  const entries = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => b.localeCompare(a));

  const results = [];
  for (const name of entries) {
    if (results.length >= limit) break;
    const metaPath = path.join(runsDir, name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      results.push(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
    } catch {
      // Skip corrupted metadata
    }
  }
  return results;
}
