import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexArgs, parseCodexJsonl } from '../src/adapters/codex.mjs';
import { buildDshArgs, buildDshOverridePatchYaml, parseDshJsonl } from '../src/adapters/dsh.mjs';
import { determineStatus } from '../src/execute.mjs';

test('codex new run args include -C, -s, effort, threadSource, and --skip-git-repo-check when non-git', () => {
  const args = buildCodexArgs({
    cwd: 'C:\\repo',
    mode: 'readonly',
    isGit: false,
    model: 'gpt-5',
    effort: 'medium',
    threadSource: 'vscode',
    sessionId: null,
    lastMessageFile: 'C:\\out\\last.txt',
  });
  assert.deepEqual(args, [
    'exec',
    '--json',
    '-o',
    'C:\\out\\last.txt',
    '-C',
    'C:\\repo',
    '-s',
    'read-only',
    '--skip-git-repo-check',
    '-m',
    'gpt-5',
    '-c',
    'model_reasoning_effort="medium"',
    '--thread-source',
    'vscode',
    '-',
  ]);
});

test('codex resume args omit -C and -s, include effort and threadSource, and pass sessionId before -', () => {
  const args = buildCodexArgs({
    cwd: 'C:\\repo',
    mode: 'inplace',
    isGit: true,
    model: null,
    effort: 'high',
    threadSource: 'vscode',
    sessionId: '01900000-0000-7000-8000-000000000001',
    lastMessageFile: 'C:\\out\\last.txt',
  });
  assert.equal(args[0], 'exec');
  assert.equal(args[1], 'resume');
  assert.ok(!args.includes('-C'));
  assert.ok(!args.includes('-s'));
  assert.ok(!args.includes('--skip-git-repo-check'));
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('--thread-source'));
  assert.equal(args.at(-2), '01900000-0000-7000-8000-000000000001');
  assert.equal(args.at(-1), '-');
});

test('parseCodexJsonl extracts sessionId, usage, toolCalls, and prefers -o last message', () => {
  const jsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-abc' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'from stream' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }),
  ].join('\n');

  const withFile = parseCodexJsonl(jsonl, 'from file\n');
  assert.equal(withFile.sessionId, 'thread-abc');
  assert.equal(withFile.toolCalls, 1);
  assert.deepEqual(withFile.usage, { input_tokens: 100, output_tokens: 20 });
  assert.equal(withFile.finalMessage, 'from file');

  const withoutFile = parseCodexJsonl(jsonl, '');
  assert.equal(withoutFile.finalMessage, 'from stream');
});

test('buildDshOverridePatchYaml generates Cordis patch with required provider/model and effort', () => {
  assert.equal(buildDshOverridePatchYaml({ model: null, effort: null }), null);
  const effortOnly = buildDshOverridePatchYaml({ model: null, effort: 'high' });
  assert.ok(effortOnly.includes('provider: "deepseek-official"'));
  assert.ok(effortOnly.includes('model: "deepseek-flash"'));
  assert.ok(effortOnly.includes('reasoningEffort: "high"'));

  const withProvider = buildDshOverridePatchYaml({ model: 'tencent-tokenhub:deepseek-v4-pro', effort: 'max' });
  assert.ok(withProvider.includes('provider: "tencent-tokenhub"'));
  assert.ok(withProvider.includes('model: "deepseek-v4-pro"'));
  assert.ok(withProvider.includes('reasoningEffort: "max"'));
});

test('dsh args put launcher flags and multiple --patch overlays before --json', () => {
  const args = buildDshArgs({
    argsPrefix: ['C:\\dsh\\bin.js'],
    useStoredCredentials: true,
    authPatchPath: 'C:\\cfg\\dsh-auth-patch.yml',
    extraPatchPaths: ['C:\\runs\\1\\dsh-override-patch.yml'],
    sessionId: 'session-123',
  });
  assert.deepEqual(args, [
    'C:\\dsh\\bin.js',
    '--profile',
    'headless',
    '--patch',
    'C:\\cfg\\dsh-auth-patch.yml',
    '--patch',
    'C:\\runs\\1\\dsh-override-patch.yml',
    '--json',
    '--session-id',
    'session-123',
    '-',
  ]);
  assert.ok(args.lastIndexOf('--patch') < args.indexOf('--json'));
});

test('parseDshJsonl parses session, step_end usage sum, turn_end, final, and error', () => {
  const jsonl = [
    JSON.stringify({ type: 'session', sessionId: 'session-xyz', cwd: 'C:\\repo' }),
    JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'read_file' }),
    JSON.stringify({
      type: 'status',
      phase: 'step_end',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
    JSON.stringify({
      type: 'status',
      phase: 'step_end',
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    }),
    JSON.stringify({ type: 'status', phase: 'turn_end', reason: 'completed' }),
    JSON.stringify({ type: 'final', text: 'OK_DSH' }),
  ].join('\n');

  const parsed = parseDshJsonl(jsonl);
  assert.equal(parsed.sessionId, 'session-xyz');
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.turnEndReason, 'completed');
  assert.equal(parsed.finalMessage, 'OK_DSH');
  assert.deepEqual(parsed.usage, { inputTokens: 30, outputTokens: 15, totalTokens: 45 });
  assert.deepEqual(parsed.errors, []);

  const errParsed = parseDshJsonl(JSON.stringify({ type: 'error', message: 'bad auth' }));
  assert.deepEqual(errParsed.errors, ['bad auth']);
});

test('determineStatus catches object turnEndReason error and aborted states', () => {
  assert.equal(determineStatus({ timedOut: false, exitCode: 0, errors: [], turnEndReason: { kind: 'completed' } }), 'ok');
  assert.equal(determineStatus({ timedOut: false, exitCode: 0, errors: [], turnEndReason: { kind: 'error' } }), 'error');
  assert.equal(determineStatus({ timedOut: false, exitCode: 0, errors: [], turnEndReason: { kind: 'aborted' } }), 'error');
  assert.equal(determineStatus({ timedOut: true, exitCode: 1, errors: [], turnEndReason: null }), 'timeout');
});
