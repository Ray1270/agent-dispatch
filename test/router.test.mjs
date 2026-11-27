import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recommendRoute } from '../src/router.mjs';

const config = JSON.parse(
  fs.readFileSync(new URL('../config/routing.json', import.meta.url), 'utf8')
);

test('recommendRoute routes <=2 low-risk files to self', () => {
  const res = recommendRoute(
    { task: '改一下端口号配置', cwd: os.tmpdir(), filesCount: 1, risk: 'low' },
    config
  );
  assert.equal(res.worker, 'self');
  assert.equal(res.requiresConfirmation, false);
});

test('recommendRoute routes refactoring and test tasks to codex', () => {
  const res = recommendRoute(
    { task: '重构认证模块并补充单元测试', cwd: os.tmpdir(), filesCount: 6, risk: 'medium' },
    config
  );
  assert.equal(res.worker, 'codex');
  assert.equal(res.fallback, 'dsh');
  assert.equal(res.requiresConfirmation, true);
});

test('recommendRoute routes automation script and Chinese doc summary to dsh', () => {
  const res = recommendRoute(
    { task: '写一个自动化脚本并生成中文调研总结文档', cwd: os.tmpdir(), risk: 'low' },
    config
  );
  assert.equal(res.worker, 'dsh');
  assert.equal(res.fallback, 'codex');
});

test('recommendRoute warns on non-git writable tasks and honors forceWorker', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-route-'));
  try {
    const res = recommendRoute(
      { task: '实现新模块', cwd: tempDir, forceWorker: 'dsh', mode: 'inplace' },
      config
    );
    assert.equal(res.worker, 'dsh');
    assert.equal(res.isGit, false);
    assert.ok(res.warnings.some((w) => w.includes('非 Git 目录写操作警告')));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
