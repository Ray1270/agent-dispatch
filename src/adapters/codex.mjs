/**
 * Build CLI arguments for `codex exec` or `codex exec resume`.
 * Note: `-C` and `-s` are only valid on `codex exec` (not `resume`, which receives cwd via spawn).
 * @param {object} options
 * @param {string} options.cwd
 * @param {'readonly'|'inplace'|'worktree'} options.mode
 * @param {boolean} options.isGit
 * @param {string | null} [options.model]
 * @param {string | null} [options.sessionId]
 * @param {string} options.lastMessageFile
 * @returns {string[]}
 */
export function buildCodexArgs({ cwd, mode, isGit, model, sessionId, lastMessageFile }) {
  if (sessionId) {
    const args = ['exec', 'resume', '--json', '-o', lastMessageFile];
    if (!isGit) args.push('--skip-git-repo-check');
    if (model) args.push('-m', model);
    args.push(sessionId, '-');
    return args;
  }

  const sandbox = mode === 'readonly' ? 'read-only' : 'workspace-write';
  const args = ['exec', '--json', '-o', lastMessageFile, '-C', cwd, '-s', sandbox];
  if (!isGit) args.push('--skip-git-repo-check');
  if (model) args.push('-m', model);
  args.push('-');
  return args;
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

  for (const line of String(rawText || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;

    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }

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
