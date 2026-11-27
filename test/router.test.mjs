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

test('recommendRoute assigns standard and heavy tiers with effort and timeout for codex', () => {
  const standard = recommendRoute(
    { task: '重构认证模块并补充单元测试', cwd: os.tmpdir(), filesCount: 3, risk: 'medium' },
    config
  );
  assert.equal(standard.worker, 'codex');
  assert.equal(standard.tier, 'standard');
  assert.equal(standard.effort, 'high');
  assert.equal(standard.timeoutSec, 600);

  const heavy = recommendRoute(
    { task: '大重构核心状态机', cwd: os.tmpdir(), filesCount: 8, risk: 'high' },
    config
  );
  assert.equal(heavy.worker, 'codex');
  assert.equal(heavy.tier, 'heavy');
  assert.equal(heavy.effort, 'ultra');
  assert.equal(heavy.timeoutSec, 1200);
});

test('recommendRoute assigns light tier for readonly codex and honors explicit model/effort overrides', () => {
  const light = recommendRoute(
    { task: 'Code review auth module', cwd: os.tmpdir(), mode: 'readonly', forceWorker: 'codex' },
    config
  );
  assert.equal(light.tier, 'light');
  assert.equal(light.effort, 'medium');

  const overridden = recommendRoute(
    {
      task: '实现新模块',
      cwd: os.tmpdir(),
      forceWorker: 'dsh',
      model: 'deepseek-v4-pro',
      effort: 'max',
    },
    config
  );
  assert.equal(overridden.model, 'deepseek-v4-pro');
  assert.equal(overridden.effort, 'max');
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
