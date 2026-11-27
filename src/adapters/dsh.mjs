import { execFileSync } from 'node:child_process';

/**
 * Query DSH's current headless `agent-default-model` config (`provider` and `model`)
 * so partial overrides (e.g. only `--effort`) preserve the required `provider` and `model` fields.
 * @param {{ command: string, argsPrefix?: string[] }} backend
 * @returns {{ provider: string, model: string }}
 */
export function resolveDshDefaultModel(backend) {
  const fallback = { provider: 'deepseek-official', model: 'deepseek-flash' };
  if (!backend?.command) return fallback;
  try {
    const out = execFileSync(
      backend.command,
      [...(backend.argsPrefix || []), '--profile', 'headless', '--dump-config'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 6000,
        windowsHide: true,
      }
    );
    const match = out.match(
      /-\s*id:\s*agent-default-model[\s\S]*?\bconfig:\s*\r?\n([\s\S]*?)(?:\r?\n\s*-\s*id:|\s*$)/
    );
    if (!match) return fallback;
    const block = match[1];
    const providerMatch = block.match(/^\s*provider:\s*['"]?([^\r\n'"]+)['"]?/m);
    const modelMatch = block.match(/^\s*model:\s*['"]?([^\r\n'"]+)['"]?/m);
    return {
      provider: providerMatch ? providerMatch[1].trim() : fallback.provider,
      model: modelMatch ? modelMatch[1].trim() : fallback.model,
    };
  } catch {
    return fallback;
  }
}

/**
 * Build a temporary Cordis YAML patch overriding `@deepseek-ai/dsh-agent-default-model`
 * (`id: agent-default-model`) when model or reasoning effort is specified.
 * Supports `provider:model` syntax or plain `model` name; always preserves required `provider` & `model`.
 * @param {{ model?: string | null, effort?: string | null, baseProvider?: string, baseModel?: string }} options
 * @returns {string | null}
 */
export function buildDshOverridePatchYaml({
  model,
  effort,
  baseProvider = 'deepseek-official',
  baseModel = 'deepseek-flash',
}) {
  if (!model && !effort) return null;

  let resolvedProvider = baseProvider;
  let resolvedModel = baseModel;
  if (model) {
    const str = String(model).trim();
    const colonIdx = str.indexOf(':');
    if (colonIdx > 0) {
      resolvedProvider = str.slice(0, colonIdx);
      resolvedModel = str.slice(colonIdx + 1);
    } else {
      resolvedModel = str;
    }
  }

  const lines = [
    '- id: agent-default-model',
    '  config:',
    `    provider: ${JSON.stringify(resolvedProvider)}`,
    `    model: ${JSON.stringify(resolvedModel)}`,
  ];
  if (effort) {
    lines.push(`    reasoningEffort: ${JSON.stringify(String(effort))}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Build CLI arguments for `dsh --profile headless`.
 * Launcher flags (`--profile`, `--patch`) MUST precede app flags (`--json`, `--session-id`, `-`).
 * @param {object} options
 * @param {string[]} [options.argsPrefix]
 * @param {boolean} options.useStoredCredentials
 * @param {string} options.authPatchPath
 * @param {string[]} [options.extraPatchPaths]
 * @param {string | null} [options.sessionId]
 * @returns {string[]}
 */
export function buildDshArgs({
  argsPrefix = [],
  useStoredCredentials,
  authPatchPath,
  extraPatchPaths = [],
  sessionId,
}) {
  const args = [...argsPrefix, '--profile', 'headless'];
  if (useStoredCredentials && authPatchPath) {
    args.push('--patch', authPatchPath);
  }
  for (const patchPath of extraPatchPaths) {
    if (patchPath) {
      args.push('--patch', patchPath);
    }
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
