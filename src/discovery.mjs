import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexBinary } from './adapters/codex.mjs';
import { resolveDshBinary } from './adapters/dsh.mjs';
import { getAdapter, getAllAdapters } from './adapters/index.mjs';
import { runQuickCommand } from './adapters/utils.mjs';
import { getDshAuthPatchPath, getStateDir } from './config.mjs';

export { resolveCodexBinary, resolveDshBinary };

/**
 * Resolve any registered worker adapter's CLI binary.
 * @param {string} workerId
 */
export function resolveAdapterBinary(workerId) {
  return getAdapter(workerId).resolveBinary();
}

/**
 * Inspect local environment readiness for all registered adapters, git, auth files, and state storage.
 * @param {Record<string, any>} config
 * @returns {Record<string, any>}
 */
export function runDoctor(config) {
  const home = os.homedir();
  const stateDir = getStateDir();
  const patchPath = getDshAuthPatchPath();

  const workers = {};
  for (const adapter of getAllAdapters()) {
    const resolved = adapter.resolveBinary();
    const version = resolved.found ? adapter.getVersion(resolved) : null;
    workers[adapter.id] = {
      ...resolved,
      displayName: adapter.displayName,
      version,
    };
  }

  workers.codex.authJsonExists = fs.existsSync(path.join(home, '.codex', 'auth.json'));
  workers.claude.authExists = fs.existsSync(path.join(home, '.claude'));
  workers.gemini.authExists = fs.existsSync(path.join(home, '.gemini'));
  workers.qwen.authExists = fs.existsSync(path.join(home, '.qwen'));

  const gitCheck = runQuickCommand('git', ['--version']);
  const enabledWorkers = Array.isArray(config?.defaults?.enabledWorkers) && config.defaults.enabledWorkers.length
    ? config.defaults.enabledWorkers
    : ['codex', 'dsh'];
  const anyEnabledReady = enabledWorkers.some((id) => workers[id]?.found);

  return {
    ok: Boolean(gitCheck.ok && anyEnabledReady),
    node: process.version,
    platform: process.platform,
    git: {
      found: gitCheck.ok,
      version: gitCheck.ok ? gitCheck.stdout : null,
    },
    enabledWorkers,
    workers,
    codex: workers.codex,
    dsh: workers.dsh,
    dshAuth: {
      useDshStoredCredentials: Boolean(config?.defaults?.useDshStoredCredentials ?? true),
      credentialsYamlExists: fs.existsSync(path.join(home, '.dsh', '.credentials.yaml')),
      dshEnvExists: fs.existsSync(path.join(home, '.dsh', '.env')),
      patchPath,
      patchExists: fs.existsSync(patchPath),
    },
    state: {
      stateDir,
      routingJsonPath: path.join(stateDir, 'routing.json'),
      routingJsonExists: fs.existsSync(path.join(stateDir, 'routing.json')),
    },
  };
}
