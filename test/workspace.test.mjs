import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  captureFsSnapshot,
  computeGitChanges,
  createWorktree,
  diffFsSnapshots,
  getGitBaseline,
  isGitRepo,
  removeWorktree,
} from '../src/workspace.mjs';

test('non-git snapshot diff detects added, modified, and deleted files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-snap-'));
  try {
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'v1', 'utf8');
    fs.writeFileSync(path.join(dir, 'mod.txt'), 'old', 'utf8');
    fs.writeFileSync(path.join(dir, 'del.txt'), 'bye', 'utf8');

    const before = captureFsSnapshot(dir);
    fs.writeFileSync(path.join(dir, 'mod.txt'), 'new', 'utf8');
    fs.unlinkSync(path.join(dir, 'del.txt'));
    fs.writeFileSync(path.join(dir, 'add.txt'), 'hi', 'utf8');
    const after = captureFsSnapshot(dir);

    const diff = diffFsSnapshots(before, after);
    assert.deepEqual(diff.added, ['add.txt']);
    assert.deepEqual(diff.modified, ['mod.txt']);
    assert.deepEqual(diff.deleted, ['del.txt']);
    assert.equal(diff.changedFiles.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('git baseline, worktree creation, diff, and safe cleanup work on a real git repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-git-'));
  const repoDir = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  try {
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

    assert.equal(isGitRepo(repoDir), true);
    const wt = createWorktree(repoDir, 'test-run-1', stateDir);
    assert.equal(fs.existsSync(wt.worktreePath), true);

    const baseline = getGitBaseline(wt.worktreePath);
    fs.writeFileSync(path.join(wt.worktreePath, 'a.txt'), 'hello world\n', 'utf8');
    const changes = computeGitChanges(wt.worktreePath, baseline);
    assert.deepEqual(changes.changedFiles, ['a.txt']);
    assert.ok(changes.diffPatch.includes('+hello world'));

    const removed = removeWorktree(repoDir, wt.worktreePath, wt.branch, {
      stateDir,
      forceBranch: true,
    });
    assert.equal(removed.removed, true);
    assert.equal(fs.existsSync(wt.worktreePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('computeGitChanges excludes preexisting dirty files from changedFiles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-dirty-'));
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'dirty.txt'), 'v1\n', 'utf8');
    fs.writeFileSync(path.join(root, 'clean.txt'), 'v1\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });

    fs.writeFileSync(path.join(root, 'dirty.txt'), 'preexisting edit\n', 'utf8');
    const baseline = getGitBaseline(root);

    fs.writeFileSync(path.join(root, 'clean.txt'), 'worker edit\n', 'utf8');
    fs.writeFileSync(path.join(root, 'newfile.txt'), 'created\n', 'utf8');
    const changes = computeGitChanges(root, baseline);

    assert.deepEqual(changes.changedFiles.sort(), ['clean.txt', 'newfile.txt']);
    assert.deepEqual(changes.preexistingDirtyFiles, ['dirty.txt']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
