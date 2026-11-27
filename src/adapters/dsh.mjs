/**
 * Build CLI arguments for `dsh --profile headless`.
 * Launcher flags (`--profile`, `--patch`) MUST precede app flags (`--json`, `--session-id`, `-`).
 * @param {object} options
 * @param {string[]} [options.argsPrefix]
 * @param {boolean} options.useStoredCredentials
 * @param {string} options.authPatchPath
 * @param {string | null} [options.sessionId]
 * @returns {string[]}
 */
export function buildDshArgs({ argsPrefix = [], useStoredCredentials, authPatchPath, sessionId }) {
  const args = [...argsPrefix, '--profile', 'headless'];
  if (useStoredCredentials && authPatchPath) {
    args.push('--patch', authPatchPath);
  }
  args.push('--json');
  if (sessionId) {
    args.push('--session-id', sessionId);
  }
  args.push('-');
  return args;
}

function addNumber(acc, key, val) {
  if (typeof val === 'number' && Number.isFinite(val)) {
    acc[key] = (acc[key] || 0) + val;
  }
}

/**
 * Parse `@deepseek-ai/dsh-headless` `--json` JSONL projection output.
 * @param {string} rawText
 */
export function parseDshJsonl(rawText) {
  let sessionId = null;
  let toolCalls = 0;
  const errors = [];
  let turnEndReason = null;
  let finalMessage = '';
  let lastTextBlock = '';
  const usageTotal = {};
  let hasUsage = false;

  for (const line of String(rawText || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;

    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (ev.type === 'session' && ev.sessionId) {
      sessionId = ev.sessionId;
    } else if (ev.type === 'tool_call') {
      toolCalls += 1;
    } else if (ev.type === 'text' && typeof ev.text === 'string') {
      lastTextBlock = ev.text;
    } else if (ev.type === 'status') {
      if (ev.phase === 'step_end' && ev.usage && typeof ev.usage === 'object') {
        hasUsage = true;
        addNumber(usageTotal, 'inputTokens', ev.usage.inputTokens);
        addNumber(usageTotal, 'outputTokens', ev.usage.outputTokens);
        addNumber(usageTotal, 'totalTokens', ev.usage.totalTokens);
        addNumber(usageTotal, 'cacheReadTokens', ev.usage.cacheReadTokens);
        addNumber(usageTotal, 'cacheWriteTokens', ev.usage.cacheWriteTokens);
        addNumber(usageTotal, 'reasoningTokens', ev.usage.reasoningTokens);
      } else if (ev.phase === 'turn_end') {
        turnEndReason = ev.reason || null;
      }
    } else if (ev.type === 'final') {
      finalMessage = typeof ev.text === 'string' ? ev.text : '';
    } else if (ev.type === 'error') {
      errors.push(String(ev.message || 'dsh error'));
    }
  }

  return {
    sessionId,
    usage: hasUsage ? usageTotal : null,
    toolCalls,
    turnEndReason,
    errors,
    finalMessage: (finalMessage || lastTextBlock || '').trim(),
  };
}
