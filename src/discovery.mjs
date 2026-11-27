import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDshAuthPatchPath, getStateDir } from './config.mjs';

function runQuickCommand(command, args) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
      windowsHide: true,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err.stdout || '').trim(),
      stderr: String(err.stderr || err.message || '').trim(),
    };
  }
}

function whereCommand(name) {
  const tool = process.platform === 'win32' ? 'where.exe' : 'which';
  const res = runQuickCommand(tool, [name]);
  if (!res.ok || !res.stdout) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Dynamically resolve codex CLI executable via CODEX_BIN, PATH, or Windows Appx OpenAI.Codex package.
 * @returns {{ found: boolean, command: string | null, source: string | null, error?: string }}
 */
export function resolveCodexBinary() {
  if (process.env.CODEX_BIN) {
    const candidate = path.resolve(process.env.CODEX_BIN);
    if (fs.existsSync(candidate)) {
      return { found: true, command: candidate, source: 'env:CODEX_BIN' };
    }
    return {
      found: false,
      command: null,
      source: 'env:CODEX_BIN',
      error: `CODEX_BIN points to missing file: ${candidate}`,
    };
  }

  for (const hit of whereCommand('codex')) {
    if (fs.existsSync(hit)) {
      return { found: true, command: hit, source: 'PATH' };
    }
  }

  if (process.platform === 'win32') {
    const psRes = runQuickCommand('powershell.exe', [
      '-NoProfile',
      '-Command',
      '(Get-AppxPackage OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation)',
    ]);
    if (psRes.ok && psRes.stdout) {
      const candidate = path.join(psRes.stdout, 'app', 'resources', 'codex.exe');
      if (fs.existsSync(candidate)) {
        return { found: true, command: candidate, source: 'appx:OpenAI.Codex' };
      }
    }
  }

  return {
    found: false,
    command: null,
    source: null,
    error: 'Could not find codex CLI via CODEX_BIN, PATH, or OpenAI.Codex Appx package.',
  };
}

/**
 * Dynamically resolve dsh CLI entrypoint, preferring direct node execution of @deepseek-ai/dsh/lib/bin.js.
 * @returns {{ found: boolean, command: string | null, argsPrefix: string[], source: string | null, error?: string }}
 */
export function resolveDshBinary() {
  if (process.env.DSH_BIN_JS) {
    const candidate = path.resolve(process.env.DSH_BIN_JS);
    if (fs.existsSync(candidate)) {
      return {
        found: true,
        command: process.execPath,
        argsPrefix: [candidate],
        source: 'env:DSH_BIN_JS',
      };
    }
    return {
      found: false,
      command: null,
      argsPrefix: [],
      source: 'env:DSH_BIN_JS',
      error: `DSH_BIN_JS points to missing file: ${candidate}`,
    };
  }

  const nodeDir = path.dirname(process.execPath);
  const siblingBinJs = path.join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(siblingBinJs)) {
    return {
      found: true,
      command: process.execPath,
      argsPrefix: [siblingBinJs],
      source: 'node-toolchain:@deepseek-ai/dsh',
    };
  }

  for (const hit of whereCommand('dsh')) {
    const hitDir = path.dirname(hit);
    const derivedBinJs = path.join(hitDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(derivedBinJs)) {
      return {
        found: true,
        command: process.execPath,
        argsPrefix: [derivedBinJs],
        source: 'PATH-derived:bin.js',
      };
    }
    if (fs.existsSync(hit) && !hit.toLowerCase().endsWith('.ps1')) {
      return {
        found: true,
        command: hit,
        argsPrefix: [],
        source: 'PATH',
      };
    }
  }

  return {
    found: false,
    command: null,
    argsPrefix: [],
    source: null,
    error: 'Could not locate @deepseek-ai/dsh bin.js or dsh executable.',
  };
}

/**
 * Inspect local environment readiness for codex, dsh, git, auth files, and state storage.
 * @param {Record<string, any>} config
 * @returns {Record<string, any>}
 */
export function runDoctor(config) {
  const home = os.homedir();
  const stateDir = getStateDir();
  const patchPath = getDshAuthPatchPath();

  const codex = resolveCodexBinary();
  let codexVersion = null;
  if (codex.found && codex.command) {
    const v = runQuickCommand(codex.command, ['--version']);
    codexVersion = v.ok ? v.stdout : v.stderr || null;
  }

  const dsh = resolveDshBinary();
  let dshVersion = null;
  if (dsh.found && dsh.command) {
    const v = runQuickCommand(dsh.command, [...dsh.argsPrefix, '--version']);
    dshVersion = v.ok ? v.stdout : v.stderr || null;
  }

  const gitCheck = runQuickCommand('git', ['--version']);

  return {
    ok: Boolean(codex.found && dsh.found && gitCheck.ok),
    node: process.version,
    platform: process.platform,
    git: {
      found: gitCheck.ok,
      version: gitCheck.ok ? gitCheck.stdout : null,
    },
    codex: {
      ...codex,
      version: codexVersion,
      authJsonExists: fs.existsSync(path.join(home, '.codex', 'auth.json')),
    },
    dsh: {
      ...dsh,
      version: dshVersion,
    },
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
