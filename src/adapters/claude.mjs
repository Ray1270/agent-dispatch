import path from 'node:path';
import { parseJsonLines, resolveNodeCliBinary, runQuickCommand, truncateText } from './utils.mjs';

/**
 * Resolve Claude Code CLI executable via CLAUDE_BIN, node_modules, or PATH.
 */
export function resolveClaudeBinary() {
  return resolveNodeCliBinary({
    envVar: 'CLAUDE_BIN',
    commandName: 'claude',
    packageRelativePath: path.join('@anthropic-ai', 'claude-code', 'cli.js'),
    sourceLabel: 'node-toolchain:@anthropic-ai/claude-code',
  });
}

/**
 * Build CLI arguments for non-interactive `claude -p --output-format stream-json`.
 * Prompt is supplied over UTF-8 stdin.
 * @param {object} options
 * @param {string[]} [options.argsPrefix]
 * @param {'readonly'|'inplace'|'worktree'} options.mode
 * @param {string | null} [options.model]
 * @param {string | null} [options.sessionId]
 * @returns {string[]}
 */
export function buildClaudeArgs({ argsPrefix = [], mode, model, sessionId }) {
  const permissionMode = mode === 'readonly' ? 'plan' : 'acceptEdits';
  const args = [
    ...argsPrefix,
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    permissionMode,
  ];
  if (model) args.push('--model', String(model));
  if (sessionId) args.push('--resume', String(sessionId));
  return args;
}

/**
 * Normalize one Claude stream-json event line for the live timeline.
 * @param {any} ev
 * @param {{ sessionId: string | null, toolCalls: number, usage: any }} state
 */
export function parseClaudeEventLine(ev, state) {
  if (!state.sessionId && ev.session_id) {
    state.sessionId = ev.session_id;
  }

  if (ev.type === 'system' && ev.subtype === 'init') {
    return { kind: 'status', title: 'Claude 会话已建立', detail: state.sessionId || '' };
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

  if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    const toolRes = ev.message.content.find((b) => b.type === 'tool_result');
    if (toolRes) {
      const text = typeof toolRes.content === 'string'
        ? toolRes.content
        : JSON.stringify(toolRes.content || '');
      return {
        kind: 'tool_result',
        title: `工具结果 (${toolRes.is_error ? 'error' : 'completed'})`,
        detail: truncateText(text, 220),
      };
    }
  }

  if (ev.type === 'result') {
    if (ev.usage) state.usage = ev.usage;
    if (ev.is_error) {
      return { kind: 'error', title: '错误', detail: truncateText(ev.result || 'Claude failed', 300) };
    }
    return { kind: 'final', title: '最终结果', detail: truncateText(ev.result || '', 320) };
  }

  if (ev.type === 'error') {
    const msg = ev.error?.message || ev.message || 'Claude error';
    return { kind: 'error', title: '错误', detail: truncateText(msg, 300) };
  }

  return null;
}

/**
 * Parse complete Claude CLI stream-json stdout into normalized run summary.
 * @param {string} rawText
 */
export function parseClaudeJsonl(rawText) {
  let sessionId = null;
  let usage = null;
  let toolCalls = 0;
  const errors = [];
  let finalResult = '';
  let lastAssistantText = '';

  for (const ev of parseJsonLines(rawText)) {
    if (!sessionId && ev.session_id) {
      sessionId = ev.session_id;
    }

    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_use') {
          toolCalls += 1;
        } else if (block.type === 'text' && typeof block.text === 'string') {
          lastAssistantText = block.text;
        }
      }
    } else if (ev.type === 'result') {
      if (ev.usage) usage = ev.usage;
      if (typeof ev.result === 'string') finalResult = ev.result;
      if (ev.is_error) {
        errors.push(String(ev.result || 'Claude execution failed'));
      }
    } else if (ev.type === 'error') {
      errors.push(String(ev.error?.message || ev.message || 'Claude error'));
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

export const claudeAdapter = {
  id: 'claude',
  displayName: 'Claude Code CLI',
  resolveBinary: resolveClaudeBinary,
  getVersion(resolved) {
    if (!resolved?.found || !resolved?.command) return null;
    const v = runQuickCommand(resolved.command, [...(resolved.argsPrefix || []), '--version']);
    return v.ok ? v.stdout : v.stderr || null;
  },
  buildArgs({ argsPrefix, mode, model, sessionId }) {
    return buildClaudeArgs({ argsPrefix, mode, model, sessionId });
  },
  parseResult(rawText) {
    return parseClaudeJsonl(rawText);
  },
  parseEventLine: parseClaudeEventLine,
};
