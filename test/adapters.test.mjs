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

import { buildClaudeArgs, parseClaudeJsonl } from '../src/adapters/claude.mjs';
import { buildGeminiArgs, parseGeminiJsonl } from '../src/adapters/gemini.mjs';
import { getAdapter, hasAdapter, listAdapterIds } from '../src/adapters/index.mjs';
import { buildQwenArgs, parseQwenJsonl } from '../src/adapters/qwen.mjs';

test('adapter registry exposes all 5 built-in adapters', () => {
  const ids = listAdapterIds();
  assert.deepEqual(ids, ['codex', 'dsh', 'claude', 'gemini', 'qwen']);
  assert.equal(hasAdapter('claude'), true);
  assert.equal(hasAdapter('unknown-bot'), false);
  assert.equal(getAdapter('gemini').id, 'gemini');
});

test('claude args and stream-json parser handle plan/acceptEdits, resume, and tool_use', () => {
  const args = buildClaudeArgs({
    argsPrefix: ['cli.js'],
    mode: 'readonly',
    model: 'sonnet',
    sessionId: 'sess-c1',
  });
  assert.deepEqual(args, [
    'cli.js',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'plan',
    '--model',
    'sonnet',
    '--resume',
    'sess-c1',
  ]);

  const parsed = parseClaudeJsonl(
    [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-c2' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'a.js' } },
            { type: 'text', text: 'working' },
          ],
        },
      }),
      JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'OK_CLAUDE',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ].join('\n')
  );
  assert.equal(parsed.sessionId, 'sess-c2');
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.finalMessage, 'OK_CLAUDE');
  assert.deepEqual(parsed.errors, []);
});

test('gemini args and stream-json parser handle plan/auto_edit, delta chunks, and errors', () => {
  const args = buildGeminiArgs({
    argsPrefix: ['gemini.js'],
    mode: 'inplace',
    model: 'gemini-2.5-pro',
    sessionId: 'latest',
  });
  assert.deepEqual(args, [
    'gemini.js',
    '-p',
    '',
    '--output-format',
    'stream-json',
    '--approval-mode',
    'auto_edit',
    '-m',
    'gemini-2.5-pro',
    '-r',
    'latest',
  ]);

  const parsed = parseGeminiJsonl(
    [
      JSON.stringify({ type: 'init', session_id: 'g-123' }),
      JSON.stringify({ type: 'tool_use', tool_name: 'read_file', parameters: {} }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'OK_', delta: true }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'GEMINI', delta: true }),
      JSON.stringify({ type: 'result', status: 'success', stats: { total_tokens: 42 } }),
    ].join('\n')
  );
  assert.equal(parsed.sessionId, 'g-123');
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.finalMessage, 'OK_GEMINI');
  assert.deepEqual(parsed.usage, { total_tokens: 42 });
});

test('qwen args and stream-json parser handle approval-mode, resume, and result', () => {
  const args = buildQwenArgs({
    argsPrefix: ['cli-entry.js'],
    mode: 'readonly',
    model: 'qwen3-coder',
    sessionId: 'q-99',
  });
  assert.deepEqual(args, [
    'cli-entry.js',
    '--output-format',
    'stream-json',
    '--approval-mode',
    'plan',
    '-m',
    'qwen3-coder',
    '-r',
    'q-99',
  ]);

  const parsed = parseQwenJsonl(
    [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'q-100' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'bash', input: {} }] },
      }),
      JSON.stringify({ type: 'result', is_error: false, result: 'OK_QWEN' }),
    ].join('\n')
  );
  assert.equal(parsed.sessionId, 'q-100');
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.finalMessage, 'OK_QWEN');
});
