import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDashboardServer, renderDashboardHtml } from '../src/dashboard.mjs';
import { parseLiveRunProgress } from '../src/events.mjs';
import { createRunDir, saveRunMeta } from '../src/store.mjs';

test('parseLiveRunProgress parses codex and dsh stdout.jsonl events', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-events-'));
  try {
    const codexDir = createRunDir(stateDir, 'run-codex-1');
    const codexStdout = path.join(codexDir, 'stdout.jsonl');
    fs.writeFileSync(
      codexStdout,
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }),
        JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0 } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }),
      ].join('\n'),
      'utf8'
    );
    const codexProg = parseLiveRunProgress({
      worker: 'codex',
      artifacts: { stdoutFile: codexStdout },
    });
    assert.equal(codexProg.sessionId, 'th-1');
    assert.equal(codexProg.toolCalls, 1);
    assert.equal(codexProg.events.length, 4);
    assert.equal(codexProg.latestStep.title, '阶段输出');

    const dshDir = createRunDir(stateDir, 'run-dsh-1');
    const dshStdout = path.join(dshDir, 'stdout.jsonl');
    fs.writeFileSync(
      dshStdout,
      [
        JSON.stringify({ type: 'session', sessionId: 'session-1' }),
        JSON.stringify({ type: 'tool_call', tool: 'read_file', input: { path: 'a.js' } }),
        JSON.stringify({ type: 'tool_result', status: 'completed', result: 'ok' }),
        JSON.stringify({ type: 'final', text: 'Finished' }),
      ].join('\n'),
      'utf8'
    );
    const dshProg = parseLiveRunProgress({
      worker: 'dsh',
      artifacts: { stdoutFile: dshStdout },
    });
    assert.equal(dshProg.sessionId, 'session-1');
    assert.equal(dshProg.toolCalls, 1);
    assert.equal(dshProg.events.length, 4);
    assert.equal(dshProg.latestStep.kind, 'final');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('createDashboardServer serves HTML dashboard and /api/runs endpoints', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ui-'));
  const runDir = createRunDir(stateDir, '20261127-190000-codex-aaaa');
  const stdoutFile = path.join(runDir, 'stdout.jsonl');
  fs.writeFileSync(stdoutFile, JSON.stringify({ type: 'thread.started', thread_id: 'th-ui' }) + '\n', 'utf8');
  saveRunMeta(runDir, {
    runId: '20261127-190000-codex-aaaa',
    worker: 'codex',
    status: 'ok',
    mode: 'readonly',
    tier: 'light',
    model: null,
    effort: 'medium',
    cwd: stateDir,
    effectiveCwd: stateDir,
    timeoutSec: 600,
    durationMs: 1200,
    toolCalls: 0,
    changedFiles: [],
    artifacts: { stdoutFile },
    createdAt: new Date().toISOString(),
  });

  const server = createDashboardServer({ stateDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('Agent Dispatch'));
    assert.ok(!html.includes('/preload.js'));

    const sidecarHtml = renderDashboardHtml({ includePreload: true });
    assert.ok(sidecarHtml.includes('<script src="/preload.js"></script>'));
    assert.ok(sidecarHtml.includes('@media (max-width: 720px)'));

    const listRes = await fetch(`${base}/api/runs`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.count, 1);
    assert.equal(listData.runs[0].effort, 'medium');

    const detailRes = await fetch(`${base}/api/runs/20261127-190000-codex-aaaa`);
    assert.equal(detailRes.status, 200);
    const detailData = await detailRes.json();
    assert.equal(detailData.sessionId, 'th-ui');
    assert.equal(detailData.events.length, 1);

    const queryDetailRes = await fetch(`${base}/api/run?id=20261127-190000-codex-aaaa`);
    assert.equal(queryDetailRes.status, 200);
    const queryDetailData = await queryDetailRes.json();
    assert.equal(queryDetailData.sessionId, 'th-ui');
    assert.equal(queryDetailData.events.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
