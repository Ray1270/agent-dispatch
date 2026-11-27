import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Return the root directory of the agent-dispatch project.
 * @returns {string}
 */
export function getProjectRoot() {
  return PROJECT_ROOT;
}

/**
 * Return the runtime state directory where routing overrides, runs, and worktrees are stored.
 * @returns {string}
 */
export function getStateDir() {
  return process.env.AGENT_DISPATCH_HOME
    ? path.resolve(process.env.AGENT_DISPATCH_HOME)
    : path.join(os.homedir(), '.agent-dispatch');
}

/**
 * Return the path to the default dsh stored-credentials patch overlay.
 * @returns {string}
 */
export function getDshAuthPatchPath() {
  return path.join(PROJECT_ROOT, 'config', 'dsh-auth-patch.yml');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merge two plain configuration objects; arrays and primitives in override replace base.
 * @param {Record<string, any>} base
 * @param {Record<string, any>} override
 * @returns {Record<string, any>}
 */
export function deepMerge(base, override) {
  if (!isPlainObject(base)) return override;
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Ensure the runtime state directory and user routing.json file exist.
 * @param {string} [stateDir]
 * @returns {{ stateDir: string, runsDir: string, worktreesDir: string, userRoutingPath: string }}
 */
export function ensureUserConfig(stateDir = getStateDir()) {
  const runsDir = path.join(stateDir, 'runs');
  const worktreesDir = path.join(stateDir, 'worktrees');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(worktreesDir, { recursive: true });

  const defaultRoutingPath = path.join(PROJECT_ROOT, 'config', 'routing.json');
  const userRoutingPath = path.join(stateDir, 'routing.json');
  if (!fs.existsSync(userRoutingPath) && fs.existsSync(defaultRoutingPath)) {
    fs.copyFileSync(defaultRoutingPath, userRoutingPath);
  }

  return { stateDir, runsDir, worktreesDir, userRoutingPath };
}

/**
 * Load default routing.json merged with the user's state-dir routing.json (if present).
 * @param {string} [stateDir]
 * @returns {Record<string, any>}
 */
export function loadConfig(stateDir = getStateDir()) {
  const defaultRoutingPath = path.join(PROJECT_ROOT, 'config', 'routing.json');
  const base = JSON.parse(fs.readFileSync(defaultRoutingPath, 'utf8'));
  const { userRoutingPath } = ensureUserConfig(stateDir);
  if (fs.existsSync(userRoutingPath)) {
    const userRaw = fs.readFileSync(userRoutingPath, 'utf8');
    const userCfg = JSON.parse(userRaw);
    return deepMerge(base, userCfg);
  }
  return base;
}
