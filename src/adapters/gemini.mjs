import path from 'node:path';
import { parseJsonLines, resolveNodeCliBinary, runQuickCommand, truncateText } from './utils.mjs';

/**
 * Resolve Gemini CLI entrypoint via GEMINI_BIN, node_modules bundle, or PATH.
 */
export function resolveGeminiBinary() {
  return resolveNodeCliBinary({
    envVar: 'GEMINI_BIN',
    commandName: 'gemini',
    packageRelativePath: path.join('@google', 'gemini-cli', 'bundle', 'gemini.js'),
    sourceLabel: 'node-toolchain:@google/gemini-cli',
  });
}

/**
 * Build CLI arguments for non-interactive `gemini -p '' --output-format stream-json`.
 * Gemini CLI appends piped stdin to `-p ""`.
 * @param {object} options
 * @param {string[]} [options.argsPrefix]
 * @param {'readonly'|'inplace'|'worktree'} options.mode
 * @param {string | null} [options.model]
 * @param {string | null} [options.sessionId]
 * @returns {string[]}
 */
export function buildGeminiArgs({ argsPrefix = [], mode, model, sessionId }) {
  const approvalMode = mode === 'readonly' ? 'plan' : 'auto_edit';
  const args = [
    ...argsPrefix,
    '-p',
    '',
    '--output-format',
    'stream-json',
    '--approval-mode',
    approvalMode,
  ];
  if (model) args.push('-m', String(model));
  if (sessionId) args.push('-r', String(sessionId));
  return args;
}

/**
 * Normalize one Gemini CLI stream-json event line for the live timeline.
 * @param {any} ev
 * @param {{ sessionId: string | null, toolCalls: number, usage: any }} state
 */
export function parseGeminiEventLine(ev, state) {
  if (!state.sessionId && (ev.session_id || ev.sessionId)) {
    state.sessionId = ev.session_id || ev.sessionId;
  }

  if (ev.type === 'init') {
    return { kind: 'status', title: 'Gemini 会话已建立', detail: state.sessionId || '' };
  }

  if (ev.type === 'message' && ev.role === 'assistant' && ev.content) {
    return { kind: 'text', title: '阶段输出', detail: truncateText(ev.content, 320) };
  }

  if (ev.type === 'tool_use') {
    state.toolCalls += 1;
    return {
      kind: 'tool_call',
      title: `调用工具: ${ev.tool_name || ev.name || 'tool'}`,
      detail: truncateText(JSON.stringify(ev.parameters || ev.input || {}), 240),
    };
  }

  if (ev.type === 'tool_result') {
    return {
      kind: 'tool_result',
      title: `工具结果 (${ev.status || 'completed'})`,
      detail: truncateText(ev.output || ev.result || '', 220),
    };
  }

  if (ev.type === 'result') {
    if (ev.stats) state.usage = ev.stats;
    if (ev.status === 'error') {
      return { kind: 'error', title: '错误', detail: truncateText(ev.error?.message || 'Gemini failed', 300) };
    }
    return { kind: 'status', title: '轮次完成', detail: ev.status || 'success' };
  }

  if (ev.type === 'error') {
    const msg = ev.message || ev.error?.message || 'Gemini error';
    return { kind: 'error', title: '错误', detail: truncateText(msg, 300) };
  }

  return null;
}

/**
 * Parse complete Gemini CLI stream-json stdout into normalized run summary.
 * @param {string} rawText
 */
export function parseGeminiJsonl(rawText) {
  let sessionId = null;
  let usage = null;
  let toolCalls = 0;
  const errors = [];
  const assistantChunks = [];

  for (const ev of parseJsonLines(rawText)) {
    if (!sessionId && (ev.session_id || ev.sessionId)) {
      sessionId = ev.session_id || ev.sessionId;
    }

    if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
      if (ev.delta) {
        assistantChunks.push(ev.content);
      } else {
        assistantChunks.length = 0;
        assistantChunks.push(ev.content);
      }
    } else if (ev.type === 'tool_use') {
      toolCalls += 1;
    } else if (ev.type === 'result') {
      if (ev.stats) usage = ev.stats;
      if (ev.status === 'error') {
        errors.push(String(ev.error?.message || ev.message || 'Gemini turn failed'));
      }
    } else if (ev.type === 'error') {
      errors.push(String(ev.message || ev.error?.message || 'Gemini error'));
    }
  }

  return {
    sessionId,
    usage,
    toolCalls,
    errors,
    finalMessage: assistantChunks.join('').trim(),
  };
}

export const geminiAdapter = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  resolveBinary: resolveGeminiBinary,
  getVersion(resolved) {
    if (!resolved?.found || !resolved?.command) return null;
    const v = runQuickCommand(resolved.command, [...(resolved.argsPrefix || []), '--version']);
    return v.ok ? v.stdout : v.stderr || null;
  },
  buildArgs({ argsPrefix, mode, model, sessionId }) {
    return buildGeminiArgs({ argsPrefix, mode, model, sessionId });
  },
  parseResult(rawText) {
    return parseGeminiJsonl(rawText);
  },
  parseEventLine: parseGeminiEventLine,
};
