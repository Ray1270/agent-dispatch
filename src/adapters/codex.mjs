import fs from 'node:fs';
import path from 'node:path';
import { parseJsonLines, runQuickCommand, truncateText, whereCommand } from './utils.mjs';

/**
 * Dynamically resolve codex CLI executable via CODEX_BIN, PATH, or Windows Appx OpenAI.Codex package.
 * @returns {{ found: boolean, command: string | null, argsPrefix: string[], source: string | null, error?: string }}
 */
export function resolveCodexBinary() {
  if (process.env.CODEX_BIN) {
    const candidate = path.resolve(process.env.CODEX_BIN);
    if (fs.existsSync(candidate)) {
      return { found: true, command: candidate, argsPrefix: [], source: 'env:CODEX_BIN' };
    }
    return {
      found: false,
      command: null,
      argsPrefix: [],
      source: 'env:CODEX_BIN',
      error: `CODEX_BIN points to missing file: ${candidate}`,
    };
  }

  for (const hit of whereCommand('codex')) {
    if (fs.existsSync(hit)) {
      return { found: true, command: hit, argsPrefix: [], source: 'PATH' };
    }
  }

  if (process.platform === 'win32') {
    const psRes = runQuickCommand('powershell.exe', [
      '-NoProfile',
      '-Command',
      '(Get-AppxPackage OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation)',
    ]);
    if (psRes.ok && psRes.stdout) {
      const candidate = path.join(psRes.stdout, 'app', 'resources', 'codex.exe');
      if (fs.existsSync(candidate)) {
        return { found: true, command: candidate, argsPrefix: [], source: 'appx:OpenAI.Codex' };
      }
    }
  }

  return {
    found: false,
    command: null,
    argsPrefix: [],
    source: null,
    error: 'Could not find codex CLI via CODEX_BIN, PATH, or OpenAI.Codex Appx package.',
  };
}

/**
 * Build CLI arguments for `codex exec` or `codex exec resume`.
 * Note: `-C` and `-s` are only valid on `codex exec` (not `resume`, which receives cwd via spawn).
 * @param {object} options
 * @param {string} options.cwd
 * @param {'readonly'|'inplace'|'worktree'} options.mode
 * @param {boolean} options.isGit
 * @param {string | null} [options.model]
 * @param {string | null} [options.effort]
 * @param {string | null} [options.threadSource]
 * @param {string | null} [options.sessionId]
 * @param {string} options.lastMessageFile
 * @returns {string[]}
 */
export function buildCodexArgs({
  cwd,
  mode,
  isGit,
  model,
  effort,
  threadSource,
  sessionId,
  lastMessageFile,
}) {
  if (sessionId) {
    const args = ['exec', 'resume', '--json', '-o', lastMessageFile];
    if (!isGit) args.push('--skip-git-repo-check');
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(String(effort))}`);
    if (threadSource) args.push('--thread-source', String(threadSource));
    args.push(sessionId, '-');
    return args;
  }

  const sandbox = mode === 'readonly' ? 'read-only' : 'workspace-write';
  const args = ['exec', '--json', '-o', lastMessageFile, '-C', cwd, '-s', sandbox];
  if (!isGit) args.push('--skip-git-repo-check');
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(String(effort))}`);
  if (threadSource) args.push('--thread-source', String(threadSource));
  args.push('-');
  return args;
}

/**
 * Normalize one Codex CLI JSONL event line for live timeline display.
 * @param {any} ev
 * @param {{ sessionId: string | null, toolCalls: number, usage: any }} state
 */
export function parseCodexEventLine(ev, state) {
  if (!state.sessionId) {
    state.sessionId = ev.thread_id || ev.session_id || ev.thread?.id || null;
  }

  if (ev.type === 'thread.started') {
    return { kind: 'status', title: 'Codex 会话已建立', detail: state.sessionId || '' };
  }

  if ((ev.type === 'item.started' || ev.type === 'item.completed') && ev.item) {
    const item = ev.item;
    const isCompleted = ev.type === 'item.completed';

    if (item.type === 'reasoning' && item.text) {
      return { kind: 'thinking', title: '思考中', detail: truncateText(item.text, 220) };
    }
    if (item.type === 'agent_message' && item.text) {
      return { kind: 'text', title: '阶段输出', detail: truncateText(item.text, 320) };
    }
    if (item.type === 'command_execution') {
      if (isCompleted) state.toolCalls += 1;
      const cmd = item.command || item.cmd || '';
      const code = item.exit_code !== undefined ? ` (exit=${item.exit_code})` : '';
      return {
        kind: isCompleted ? 'tool_result' : 'tool_call',
        title: isCompleted ? `命令完成${code}` : '执行命令',
        detail: truncateText(cmd, 240),
      };
    }
    if (item.type === 'file_change') {
      if (isCompleted) state.toolCalls += 1;
      const changes = Array.isArray(item.changes)
        ? item.changes.map((c) => `${c.kind || 'edit'} ${c.path || ''}`).join(', ')
        : '';
      return {
        kind: 'tool_result',
        title: '文件变更',
        detail: truncateText(changes || JSON.stringify(item), 240),
      };
    }
    if (item.type === 'mcp_tool_call') {
      if (isCompleted) state.toolCalls += 1;
      return {
        kind: isCompleted ? 'tool_result' : 'tool_call',
        title: `${isCompleted ? 'MCP 完成' : '调用 MCP'}: ${item.tool || item.name || ''}`,
        detail: truncateText(item.server || '', 180),
      };
    }
    if (item.type === 'web_search') {
      if (isCompleted) state.toolCalls += 1;
      return {
        kind: isCompleted ? 'tool_result' : 'tool_call',
        title: '网页搜索',
        detail: truncateText(item.query || '', 200),
      };
    }
  }

  if (ev.type === 'turn.completed') {
    if (ev.usage) state.usage = ev.usage;
    return { kind: 'status', title: '轮次完成', detail: ev.usage ? `tokens: ${JSON.stringify(ev.usage)}` : '' };
  }
  if (ev.type === 'error' || ev.type === 'turn.failed') {
    const msg = ev.message || ev.error?.message || 'Codex error';
    return { kind: 'error', title: '错误', detail: truncateText(msg, 300) };
  }
  return null;
}

/**
 * Parse Codex CLI `--json` JSONL output and `-o` last message file.
 * @param {string} rawText
 * @param {string} [lastMessageFileContent]
 */
export function parseCodexJsonl(rawText, lastMessageFileContent = '') {
  let sessionId = null;
  let usage = null;
  let toolCalls = 0;
  const errors = [];
  let lastAgentMessage = null;

  for (const ev of parseJsonLines(rawText)) {
    if (!sessionId) {
      sessionId = ev.thread_id || ev.session_id || ev.thread?.id || null;
    }

    if (ev.type === 'item.completed' && ev.item) {
      const itemType = ev.item.type;
      if (itemType === 'agent_message' && typeof ev.item.text === 'string') {
        lastAgentMessage = ev.item.text;
      } else if (
        itemType === 'command_execution' ||
        itemType === 'mcp_tool_call' ||
        itemType === 'file_change' ||
        itemType === 'web_search'
      ) {
        toolCalls += 1;
      }
    } else if (ev.type === 'turn.completed' && ev.usage) {
      usage = ev.usage;
    } else if (ev.type === 'usage' && ev.usage) {
      usage = ev.usage;
    } else if (ev.type === 'error') {
      const msg = ev.message || ev.error?.message || JSON.stringify(ev);
      errors.push(String(msg));
    } else if (ev.type === 'turn.failed') {
      const msg = ev.error?.message || ev.message || 'Codex turn failed';
      errors.push(String(msg));
    }
  }

  const fileMsg = String(lastMessageFileContent || '').trim();
  const finalMessage = fileMsg || (lastAgentMessage ? lastAgentMessage.trim() : '');

  return {
    sessionId,
    usage,
    toolCalls,
    errors,
    finalMessage,
  };
}

export const codexAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  usesLastMessageFile: true,
  resolveBinary: resolveCodexBinary,
  getVersion(resolved) {
    if (!resolved?.found || !resolved?.command) return null;
    const v = runQuickCommand(resolved.command, ['--version']);
    return v.ok ? v.stdout : v.stderr || null;
  },
  buildArgs({ cwd, mode, isGit, model, effort, threadSource, sessionId, lastMessageFile }) {
    return buildCodexArgs({
      cwd,
      mode,
      isGit,
      model,
      effort,
      threadSource,
      sessionId,
      lastMessageFile,
    });
  },
  parseResult(rawText, lastMessageFileContent = '') {
    return parseCodexJsonl(rawText, lastMessageFileContent);
  },
  parseEventLine: parseCodexEventLine,
};
