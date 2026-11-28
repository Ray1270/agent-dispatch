import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonLines, resolveNodeCliBinary, runQuickCommand, truncateText } from './utils.mjs';

/**
 * Dynamically resolve dsh CLI entrypoint, preferring direct node execution of @deepseek-ai/dsh/lib/bin.js.
 * @returns {{ found: boolean, command: string | null, argsPrefix: string[], source: string | null, error?: string }}
 */
export function resolveDshBinary() {
  return resolveNodeCliBinary({
    envVar: 'DSH_BIN_JS',
    commandName: 'dsh',
    packageRelativePath: path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    sourceLabel: 'node-toolchain:@deepseek-ai/dsh',
  });
}

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
 * Normalize one DSH headless JSONL event line for live timeline display.
 * @param {any} ev
 * @param {{ sessionId: string | null, toolCalls: number, usage: any }} state
 */
export function parseDshEventLine(ev, state) {
  if (ev.type === 'session' && ev.sessionId) {
    state.sessionId = ev.sessionId;
    return { kind: 'status', title: 'DSH 会话已建立', detail: ev.sessionId };
  }
  if (ev.type === 'status') {
    if (ev.phase === 'step_end' && ev.usage) {
      state.usage = state.usage || {};
      for (const k of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'reasoningTokens']) {
        if (typeof ev.usage[k] === 'number') {
          state.usage[k] = (state.usage[k] || 0) + ev.usage[k];
        }
      }
      return { kind: 'status', title: `步骤 ${ev.step ?? ''} 完成`.trim(), detail: `totalTokens=${state.usage.totalTokens ?? '-'}` };
    }
    if (ev.phase === 'turn_start') {
      return { kind: 'status', title: '开始推理轮次', detail: '' };
    }
    if (ev.phase === 'step_start') {
      return { kind: 'status', title: `步骤 ${ev.step ?? ''} 开始`.trim(), detail: '' };
    }
    if (ev.phase === 'turn_end') {
      const reason = typeof ev.reason === 'string' ? ev.reason : ev.reason?.kind || '';
      return { kind: 'status', title: '轮次结束', detail: reason };
    }
  }
  if (ev.type === 'thinking' && ev.text) {
    return { kind: 'thinking', title: '思考', detail: truncateText(ev.text, 220) };
  }
  if (ev.type === 'text' && ev.text) {
    return { kind: 'text', title: '阶段输出', detail: truncateText(ev.text, 320) };
  }
  if (ev.type === 'tool_call') {
    state.toolCalls += 1;
    const inputPreview = typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input || {});
    return {
      kind: 'tool_call',
      title: `调用工具: ${ev.tool || 'unknown'}`,
      detail: truncateText(inputPreview, 240),
    };
  }
  if (ev.type === 'tool_result') {
    return {
      kind: 'tool_result',
      title: `工具结果 (${ev.status || 'completed'})`,
      detail: truncateText(ev.result || '', 220),
    };
  }
  if (ev.type === 'final') {
    return { kind: 'final', title: '最终结果', detail: truncateText(ev.text || '', 320) };
  }
  if (ev.type === 'error') {
    return { kind: 'error', title: '错误', detail: truncateText(ev.message || '', 300) };
  }
  return null;
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

  for (const ev of parseJsonLines(rawText)) {
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

export const dshAdapter = {
  id: 'dsh',
  displayName: 'DeepSeek Harness (dsh)',
  resolveBinary: resolveDshBinary,
  getVersion(resolved) {
    if (!resolved?.found || !resolved?.command) return null;
    const v = runQuickCommand(resolved.command, [...(resolved.argsPrefix || []), '--version']);
    return v.ok ? v.stdout : v.stderr || null;
  },
  prepareRun({ backend, model, effort, dryRun, runDir, stateDir }) {
    if (!model && !effort) {
      return { extraPatchPaths: [], dshOverridePatch: null, dshOverridePatchFile: null };
    }
    const base = dryRun
      ? { provider: 'deepseek-official', model: 'deepseek-flash' }
      : resolveDshDefaultModel(backend);
    const dshOverridePatch = buildDshOverridePatchYaml({
      model,
      effort,
      baseProvider: base.provider,
      baseModel: base.model,
    });
    if (!dshOverridePatch) {
      return { extraPatchPaths: [], dshOverridePatch: null, dshOverridePatchFile: null };
    }
    if (dryRun) {
      const fakePath = path.join(stateDir, 'runs', '<run-id>', 'dsh-override-patch.yml');
      return { extraPatchPaths: [fakePath], dshOverridePatch, dshOverridePatchFile: null };
    }
    const file = path.join(runDir, 'dsh-override-patch.yml');
    fs.writeFileSync(file, dshOverridePatch, 'utf8');
    return { extraPatchPaths: [file], dshOverridePatch, dshOverridePatchFile: file };
  },
  buildArgs({ argsPrefix, useStoredCredentials, authPatchPath, extraPatchPaths, sessionId }) {
    return buildDshArgs({
      argsPrefix,
      useStoredCredentials,
      authPatchPath,
      extraPatchPaths,
      sessionId,
    });
  },
  parseResult(rawText) {
    return parseDshJsonl(rawText);
  },
  parseEventLine: parseDshEventLine,
};
