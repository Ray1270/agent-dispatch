import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Run a short synchronous CLI probe (e.g. --version, where.exe, Get-AppxPackage).
 * @param {string} command
 * @param {string[]} args
 */
export function runQuickCommand(command, args) {
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

/**
 * Locate matching commands on PATH via where.exe (Windows) or which (POSIX).
 * @param {string} name
 * @returns {string[]}
 */
export function whereCommand(name) {
  const tool = process.platform === 'win32' ? 'where.exe' : 'which';
  const res = runQuickCommand(tool, [name]);
  if (!res.ok || !res.stdout) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve a Node-based CLI entrypoint or native executable cleanly on Windows and POSIX,
 * avoiding PowerShell .ps1 wrapper issues when spawning directly from Node.
 * @param {object} options
 * @param {string} options.envVar
 * @param {string} options.commandName
 * @param {string} [options.packageRelativePath]
 * @param {string} [options.sourceLabel]
 */
export function resolveNodeCliBinary({
  envVar,
  commandName,
  packageRelativePath,
  sourceLabel,
}) {
  if (envVar && process.env[envVar]) {
    const candidate = path.resolve(process.env[envVar]);
    if (fs.existsSync(candidate)) {
      const isJs = /\.(mjs|cjs|js)$/i.test(candidate);
      return {
        found: true,
        command: isJs ? process.execPath : candidate,
        argsPrefix: isJs ? [candidate] : [],
        source: `env:${envVar}`,
      };
    }
    return {
      found: false,
      command: null,
      argsPrefix: [],
      source: `env:${envVar}`,
      error: `${envVar} points to missing file: ${candidate}`,
    };
  }

  if (packageRelativePath) {
    const nodeDir = path.dirname(process.execPath);
    const siblingJs = path.join(nodeDir, 'node_modules', packageRelativePath);
    if (fs.existsSync(siblingJs)) {
      return {
        found: true,
        command: process.execPath,
        argsPrefix: [siblingJs],
        source: sourceLabel || `node-toolchain:${commandName}`,
      };
    }
  }

  for (const hit of whereCommand(commandName)) {
    if (packageRelativePath) {
      const derivedJs = path.join(path.dirname(hit), 'node_modules', packageRelativePath);
      if (fs.existsSync(derivedJs)) {
        return {
          found: true,
          command: process.execPath,
          argsPrefix: [derivedJs],
          source: `PATH-derived:${path.basename(packageRelativePath)}`,
        };
      }
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
    error: `Could not locate ${commandName} CLI executable.`,
  };
}

/**
 * Truncate and collapse whitespace for live event timeline summaries.
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string}
 */
export function truncateText(text, maxLen = 280) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

/**
 * Parse newline-delimited JSON objects safely, skipping non-JSON lines.
 * @param {string} rawText
 * @returns {any[]}
 */
export function parseJsonLines(rawText) {
  const items = [];
  for (const line of String(rawText || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed/non-JSON output lines
    }
  }
  return items;
}
