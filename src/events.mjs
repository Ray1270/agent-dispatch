import fs from 'node:fs';

function truncateText(text, maxLen = 280) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

/**
 * Safely check whether a PID is still alive.
 * @param {number | null | undefined} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function parseCodexEventLine(ev, state) {
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

function parseDshEventLine(ev, state) {
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
 * Parse a run's stdout.jsonl into normalized timeline events for live progress display.
 * @param {Record<string, any>} meta
 * @param {{ maxEvents?: number }} [options]
 */
export function parseLiveRunProgress(meta, { maxEvents = 200 } = {}) {
  const stdoutFile = meta?.artifacts?.stdoutFile;
  const state = {
    sessionId: meta?.sessionId || null,
    toolCalls: 0,
    eventCount: 0,
    lastEventAt: null,
    latestStep: null,
    usage: meta?.usage || null,
    events: [],
  };

  if (!stdoutFile || !fs.existsSync(stdoutFile)) {
    return state;
  }

  let raw = '';
  try {
    raw = fs.readFileSync(stdoutFile, 'utf8');
    const stat = fs.statSync(stdoutFile);
    state.lastEventAt = stat.mtime.toISOString();
  } catch {
    return state;
  }

  const parser = meta.worker === 'dsh' ? parseDshEventLine : parseCodexEventLine;
  const allEvents = [];
  let idx = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = parser(ev, state);
    if (parsed) {
      idx += 1;
      allEvents.push({ index: idx, ...parsed });
    }
  }

  state.eventCount = allEvents.length;
  state.latestStep = allEvents.length > 0 ? allEvents[allEvents.length - 1] : null;
  state.events = allEvents.length > maxEvents ? allEvents.slice(-maxEvents) : allEvents;
  return state;
}
