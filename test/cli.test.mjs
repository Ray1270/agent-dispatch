import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DISPATCH_BIN = path.join(PROJECT_ROOT, 'bin', 'dispatch.mjs');

function runCli(args, envOverrides = {}) {
  const stdout = execFileSync(process.execPath, [DISPATCH_BIN, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...envOverrides },
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

test('CLI doctor reports valid environment', () => {
  const tempState = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cli-state-'));
  try {
    const res = runCli(['doctor'], { AGENT_DISPATCH_HOME: tempState });
    assert.equal(res.codex.found, true);
    assert.equal(res.dsh.found, true);
    assert.equal(res.git.found, true);
    assert.equal(fs.existsSync(path.join(tempState, 'routing.json')), true);
  } finally {
    fs.rmSync(tempState, { recursive: true, force: true });
  }
});

test('CLI route returns recommendation JSON', () => {
  const tempState = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cli-state-'));
  try {
    const res = runCli(
      ['route', '--task', '重构登录模块并写测试', '--cwd', PROJECT_ROOT],
      { AGENT_DISPATCH_HOME: tempState }
    );
    assert.equal(res.worker, 'codex');
    assert.equal(res.fallback, 'dsh');
  } finally {
    fs.rmSync(tempState, { recursive: true, force: true });
  }
});

test('CLI run --dry-run builds valid codex and dsh plans', () => {
  const tempState = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cli-state-'));
  try {
    const codexPlan = runCli(
      [
        'run',
        '--worker',
        'codex',
        '--mode',
        'readonly',
        '--cwd',
        PROJECT_ROOT,
        '--task',
        'Inspect files',
        '--dry-run',
      ],
      { AGENT_DISPATCH_HOME: tempState }
    );
    assert.equal(codexPlan.dryRun, true);
    assert.equal(codexPlan.worker, 'codex');
    assert.ok(codexPlan.args.includes('-s'));
    assert.ok(codexPlan.args.includes('read-only'));

    const dshPlan = runCli(
      [
        'run',
        '--worker',
        'dsh',
        '--mode',
        'readonly',
        '--cwd',
        PROJECT_ROOT,
        '--task',
        'Inspect files',
        '--dry-run',
      ],
      { AGENT_DISPATCH_HOME: tempState }
    );
    assert.equal(dshPlan.dryRun, true);
    assert.equal(dshPlan.worker, 'dsh');
    assert.ok(dshPlan.args.includes('--profile'));
    assert.ok(dshPlan.args.includes('headless'));
    assert.ok(dshPlan.args.includes('--patch'));
    assert.ok(dshPlan.args.includes('--json'));
  } finally {
    fs.rmSync(tempState, { recursive: true, force: true });
  }
});
