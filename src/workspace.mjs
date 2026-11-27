import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SNAPSHOT_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  '.turbo',
]);

const MAX_SNAPSHOT_FILES = 5000;
const MAX_HASH_BYTES = 5 * 1024 * 1024;

function runGit(cwd, args, allowFailure = false) {
  try {
    const stdout = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (err) {
    if (allowFailure) {
      return {
        ok: false,
        stdout: String(err.stdout || ''),
        stderr: String(err.stderr || err.message || ''),
      };
    }
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${String(err.stderr || err.message || '').trim()}`);
  }
}

/**
 * Check whether the given directory is inside a Git working tree.
 * @param {string} cwd
 * @returns {boolean}
 */
export function isGitRepo(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return false;
  const res = runGit(cwd, ['rev-parse', '--is-inside-work-tree'], true);
  return res.ok && res.stdout.trim() === 'true';
}

function parsePorcelain(raw) {
  const entries = new Map();
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    let filePath = line.slice(3).trim();
    if (filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ').pop().trim();
    }
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }
    entries.set(filePath, status);
  }
  return entries;
}

/**
 * Capture current Git HEAD, branch, and porcelain status baseline before dispatching.
 * @param {string} cwd
 */
export function getGitBaseline(cwd) {
  const headRes = runGit(cwd, ['rev-parse', 'HEAD'], true);
  const branchRes = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], true);
  const statusRes = runGit(cwd, ['status', '--porcelain=v1'], true);
  const statusMap = parsePorcelain(statusRes.stdout);
  return {
    head: headRes.ok ? headRes.stdout.trim() : null,
    branch: branchRes.ok ? branchRes.stdout.trim() : null,
    dirty: statusMap.size > 0,
    preexistingDirtyFiles: Object.fromEntries(statusMap.entries()),
  };
}

/**
 * Create an isolated Git worktree under <stateDir>/worktrees/<runId> on branch dispatch/<runId>.
 * @param {string} repoCwd
 * @param {string} runId
 * @param {string} stateDir
 */
export function createWorktree(repoCwd, runId, stateDir) {
  const baseline = getGitBaseline(repoCwd);
  if (!baseline.head) {
    throw new Error('Cannot create Git worktree in a repository with no commits (no HEAD).');
  }
  const worktreesRoot = path.join(stateDir, 'worktrees');
  fs.mkdirSync(worktreesRoot, { recursive: true });
  const worktreePath = path.join(worktreesRoot, runId);
  const branch = `dispatch/${runId}`;

  runGit(repoCwd, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);

  const warning = baseline.dirty
    ? '主工作区存在未提交改动；新建的 worktree 基于 HEAD 创建，不包含这些未提交修改。'
    : null;

  return { worktreePath, branch, head: baseline.head, warning };
}

/**
 * Safely remove a managed Git worktree located inside <stateDir>/worktrees.
 * @param {string} repoCwd
 * @param {string} worktreePath
 * @param {string} branch
 * @param {{ stateDir: string, forceBranch?: boolean }} options
 */
export function removeWorktree(repoCwd, worktreePath, branch, { stateDir, forceBranch = false }) {
  const worktreesRoot = path.resolve(path.join(stateDir, 'worktrees'));
  const resolvedTarget = path.resolve(worktreePath);
  if (!resolvedTarget.startsWith(worktreesRoot + path.sep)) {
    throw new Error(`Refusing to remove unmanaged path outside ${worktreesRoot}: ${resolvedTarget}`);
  }

  if (fs.existsSync(resolvedTarget)) {
    runGit(repoCwd, ['worktree', 'remove', '--force', resolvedTarget]);
  } else {
    runGit(repoCwd, ['worktree', 'prune'], true);
  }

  let branchDeleted = false;
  let branchNote = null;
  if (branch) {
    const flag = forceBranch ? '-D' : '-d';
    const delRes = runGit(repoCwd, ['branch', flag, branch], true);
    branchDeleted = delRes.ok;
    if (!delRes.ok) {
      branchNote = (delRes.stderr || 'Branch not deleted (may contain unmerged commits; pass --force-branch to force delete).').trim();
    }
  }

  return { removed: true, worktreePath: resolvedTarget, branch, branchDeleted, branchNote };
}

/**
 * Compute Git changes after worker execution, highlighting newly touched files vs pre-existing dirty files.
 * @param {string} cwd
 * @param {ReturnType<typeof getGitBaseline> | null} baseline
 */
export function computeGitChanges(cwd, baseline) {
  const statusRes = runGit(cwd, ['status', '--porcelain=v1'], true);
  const currentMap = parsePorcelain(statusRes.stdout);
  const preexisting = baseline?.preexistingDirtyFiles || {};

  const fileStatuses = [];
  for (const [file, status] of currentMap.entries()) {
    if (!(file in preexisting) || preexisting[file] !== status) {
      fileStatuses.push({ path: file, status: status.trim() || status });
    } else {
      fileStatuses.push({ path: file, status: status.trim() || status, preexisting: true });
    }
  }

  const diffStatRes = runGit(cwd, ['diff', '--stat', 'HEAD'], true);
  const diffPatchRes = runGit(cwd, ['diff', 'HEAD'], true);

  return {
    changedFiles: fileStatuses.filter((c) => !c.preexisting).map((c) => c.path),
    preexistingDirtyFiles: fileStatuses.filter((c) => c.preexisting).map((c) => c.path),
    fileStatuses,
    diffStat: (diffStatRes.stdout || '').trim(),
    diffPatch: diffPatchRes.stdout || '',
  };
}

function hashFile(filePath, size) {
  if (size > MAX_HASH_BYTES) {
    return null;
  }
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/**
 * Capture a lightweight file tree snapshot (for non-Git directories).
 * @param {string} rootDir
 */
export function captureFsSnapshot(rootDir) {
  const files = {};
  let count = 0;
  let truncated = false;

  function walk(dir) {
    if (truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) break;
      if (entry.isDirectory()) {
        if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        if (count >= MAX_SNAPSHOT_FILES) {
          truncated = true;
          break;
        }
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(rootDir, fullPath).replaceAll('\\', '/');
        try {
          const stat = fs.statSync(fullPath);
          files[relPath] = {
            size: stat.size,
            mtimeMs: Math.trunc(stat.mtimeMs),
            sha256: hashFile(fullPath, stat.size),
          };
          count += 1;
        } catch {
          // Ignore unreadable transient files
        }
      }
    }
  }

  walk(rootDir);
  return { rootDir, fileCount: count, truncated, files };
}

/**
 * Compare two non-Git filesystem snapshots and report added, modified, and deleted paths.
 * @param {ReturnType<typeof captureFsSnapshot>} before
 * @param {ReturnType<typeof captureFsSnapshot>} after
 */
export function diffFsSnapshots(before, after) {
  const beforeFiles = before?.files || {};
  const afterFiles = after?.files || {};
  const added = [];
  const modified = [];
  const deleted = [];

  for (const [rel, meta] of Object.entries(afterFiles)) {
    if (!(rel in beforeFiles)) {
      added.push(rel);
    } else {
      const prev = beforeFiles[rel];
      const changed = prev.sha256 && meta.sha256
        ? prev.sha256 !== meta.sha256
        : prev.size !== meta.size || prev.mtimeMs !== meta.mtimeMs;
      if (changed) {
        modified.push(rel);
      }
    }
  }

  for (const rel of Object.keys(beforeFiles)) {
    if (!(rel in afterFiles)) {
      deleted.push(rel);
    }
  }

  return {
    added,
    modified,
    deleted,
    changedFiles: [...added, ...modified, ...deleted],
    truncated: Boolean(before?.truncated || after?.truncated),
  };
}
