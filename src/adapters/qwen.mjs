import path from 'node:path';
import { parseJsonLines, resolveNodeCliBinary, runQuickCommand, truncateText } from './utils.mjs';

/**
 * Resolve Qwen Code CLI entrypoint via QWEN_BIN, node_modules, or PATH.
 */
export function resolveQwenBinary() {
  return resolveNodeCliBinary({
    envVar: 'QWEN_BIN',
    commandName: 'qwen',
    packageRelativePath: path.join('@qwen-code', 'qwen-code', 'cli-entry.js'),
    sourceLabel: 'node-toolchain:@qwen-code/qwen-code',
  });
}

/**
 * Build CLI arguments for non-interactive `qwen --output-format stream-json`.
 * Prompt is supplied via piped UTF-8 stdin.
 * @param {object} options
 * @param {string[]} [options.argsPrefix]
 * @param {'readonly'|'inplace'|'worktree'} options.mode
 * @param {string | null} [options.model]
 * @param {string | null} [options.sessionId]
 * @returns {string[]}
 */
export function buildQwenArgs({ argsPrefix = [], mode, model, sessionId }) {
  const approvalMode = mode === 'readonly' ? 'plan' : 'auto-edit';
  const args = [
    ...argsPrefix,
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
 * Normalize one Qwen Code stream-json event line for the live timeline.
 * @param {any} ev
 * @param {{ sessionId: string | null, toolCalls: number, usage: any }} state
 */
export function parseQwenEventLine(ev, state) {
  if (!state.sessionId && (ev.session_id || ev.sessionId)) {
    state.sessionId = ev.session_id || ev.sessionId;
  }

  if ((ev.type === 'system' && ev.subtype === 'init') || ev.type === 'init') {
    return { kind: 'status', title: 'Qwen 会话已建立', detail: state.sessionId || '' };
  }

  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    const toolUses = ev.message.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length > 0) {
      state.toolCalls += toolUses.length;
      const first = toolUses[0];
      return {
        kind: 'tool_call',
        title: `调用工具: ${first.name || 'tool'}`,
        detail: truncateText(JSON.stringify(first.input || {}), 240),
      };
    }
    const textBlocks = ev.message.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    if (textBlocks.trim()) {
      return { kind: 'text', title: '阶段输出', detail: truncateText(textBlocks, 320) };
    }
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
    if (ev.usage || ev.stats) state.usage = ev.usage || ev.stats;
    if (ev.is_error || ev.status === 'error') {
      return { kind: 'error', title: '错误', detail: truncateText(ev.result || ev.error?.message || 'Qwen failed', 300) };
    }
    return { kind: 'final', title: '最终结果', detail: truncateText(ev.result || '', 320) };
  }

  if (ev.type === 'error') {
    const msg = ev.message || ev.error?.message || 'Qwen error';
    return { kind: 'error', title: '错误', detail: truncateText(msg, 300) };
  }

  return null;
}

/**
 * Parse complete Qwen Code stream-json stdout into normalized run summary.
 * @param {string} rawText
 */
export function parseQwenJsonl(rawText) {
  let sessionId = null;
  let usage = null;
  let toolCalls = 0;
  const errors = [];
  let finalResult = '';
  let lastAssistantText = '';

  for (const ev of parseJsonLines(rawText)) {
    if (!sessionId && (ev.session_id || ev.sessionId)) {
      sessionId = ev.session_id || ev.sessionId;
    }

    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_use') {
          toolCalls += 1;
        } else if (block.type === 'text' && typeof block.text === 'string') {
          lastAssistantText = block.text;
        }
      }
    } else if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
      lastAssistantText = ev.content;
    } else if (ev.type === 'tool_use') {
      toolCalls += 1;
    } else if (ev.type === 'result') {
      if (ev.usage || ev.stats) usage = ev.usage || ev.stats;
      if (typeof ev.result === 'string') finalResult = ev.result;
      if (ev.is_error || ev.status === 'error') {
        errors.push(String(ev.result || ev.error?.message || 'Qwen execution failed'));
      }
    } else if (ev.type === 'error') {
      errors.push(String(ev.message || ev.error?.message || 'Qwen error'));
    }
  }

  return {
    sessionId,
    usage,
    toolCalls,
    errors,
    finalMessage: (finalResult || lastAssistantText || '').trim(),
  };
}

export const qwenAdapter = {
  id: 'qwen',
  displayName: 'Qwen Code CLI',
  resolveBinary: resolveQwenBinary,
  getVersion(resolved) {
    if (!resolved?.found || !resolved?.command) return null;
    const v = runQuickCommand(resolved.command, [...(resolved.argsPrefix || []), '--version']);
    return v.ok ? v.stdout : v.stderr || null;
  },
  buildArgs({ argsPrefix, mode, model, sessionId }) {
    return buildQwenArgs({ argsPrefix, mode, model, sessionId });
  },
  parseResult(rawText) {
    return parseQwenJsonl(rawText);
  },
  parseEventLine: parseQwenEventLine,
};
