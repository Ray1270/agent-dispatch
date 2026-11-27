import fs from 'node:fs';
import http from 'node:http';
import { isPidAlive, parseLiveRunProgress } from './events.mjs';
import { listRuns, loadRunMeta } from './store.mjs';

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readTail(filePath, maxBytes = 4096) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) {
      return fs.readFileSync(filePath, 'utf8');
    }
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
      return '...\n' + buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readHead(filePath, maxBytes = 20480) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) {
      return fs.readFileSync(filePath, 'utf8');
    }
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.toString('utf8') + '\n... (truncated)';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function enrichRunSummary(meta) {
  const progress = parseLiveRunProgress(meta, { maxEvents: 10 });
  const startedMs = meta.startedAt ? Date.parse(meta.startedAt) : Date.parse(meta.createdAt || '');
  const isRunning = meta.status === 'running';
  const pidAlive = isRunning ? isPidAlive(meta.pid) : false;
  const elapsedMs = isRunning && Number.isFinite(startedMs)
    ? Math.max(0, Date.now() - startedMs)
    : (meta.durationMs || 0);

  return {
    runId: meta.runId,
    worker: meta.worker,
    status: meta.status,
    isAlive: pidAlive,
    mode: meta.mode,
    tier: meta.tier || null,
    model: meta.model || null,
    effort: meta.effort || null,
    cwd: meta.cwd,
    effectiveCwd: meta.effectiveCwd,
    sessionId: progress.sessionId || meta.sessionId || null,
    timeoutSec: meta.timeoutSec || null,
    elapsedMs,
    toolCalls: isRunning ? progress.toolCalls : (meta.toolCalls ?? progress.toolCalls),
    latestStep: progress.latestStep,
    changedFilesCount: Array.isArray(meta.changedFiles) ? meta.changedFiles.length : 0,
    startedAt: meta.startedAt || meta.createdAt,
    finishedAt: meta.finishedAt || null,
  };
}

/**
 * Return enriched list of recent runs for dashboard /api/runs.
 * @param {string} stateDir
 * @param {number} [limit]
 */
export function getRunsPayload(stateDir, limit = 40) {
  const runs = listRuns(stateDir, limit).map(enrichRunSummary);
  return { count: runs.length, runs };
}

/**
 * Return detailed metadata, normalized live events, stderr tail, and diff preview for one run.
 * @param {string} stateDir
 * @param {string} runId
 */
export function getRunDetailPayload(stateDir, runId) {
  const meta = loadRunMeta(stateDir, runId);
  const progress = parseLiveRunProgress(meta, { maxEvents: 200 });
  const stderrTail = readTail(meta.artifacts?.stderrFile, 4096);
  const diffPreview = readHead(meta.artifacts?.diffFile, 20480);
  return {
    meta,
    isAlive: meta.status === 'running' ? isPidAlive(meta.pid) : false,
    sessionId: progress.sessionId,
    toolCalls: progress.toolCalls,
    events: progress.events,
    stderrTail,
    diffPreview,
  };
}

/**
 * Render self-contained responsive HTML for both the Antigravity side-pane sidecar and standalone browser UI.
 * @param {{ includePreload?: boolean }} [options]
 * @returns {string}
 */
export function renderDashboardHtml({ includePreload = false } = {}) {
  const preloadTag = includePreload ? '\n<script src="/preload.js"></script>' : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Agent Dispatch 实时看板</title>${preloadTag}
<style>
  :root {
    --bg: var(--background, #0d1117);
    --panel: var(--card, #161b22);
    --panel-alt: var(--secondary, #0f141b);
    --border: var(--border, #30363d);
    --text: var(--foreground, #e6edf3);
    --muted: var(--muted-foreground, #8b949e);
    --accent: var(--primary, #58a6ff);
    --ok: #3fb950;
    --warn: #d29922;
    --err: #f85149;
    --run: #388bfd;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
  }
  header {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--panel);
    gap: 8px;
  }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; }
  header .sub { font-size: 11px; color: var(--muted); white-space: nowrap; }
  .compact-bar {
    display: none;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    gap: 8px;
    align-items: center;
  }
  .compact-bar select {
    flex: 1;
    min-width: 0;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 12px;
  }
  .layout { display: grid; grid-template-columns: 320px 1fr; height: calc(100vh - 43px); }
  .sidebar { border-right: 1px solid var(--border); overflow-y: auto; padding: 10px; }
  .main { overflow-y: auto; padding: 14px 16px; }
  @media (max-width: 720px) {
    .compact-bar { display: flex; }
    .layout { display: block; height: auto; }
    .sidebar { display: none; }
    .main { padding: 12px; }
  }
  .run-card {
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 8px;
    cursor: pointer;
    background: var(--panel);
  }
  .run-card.active { border-color: var(--accent); background: rgba(88, 166, 255, 0.08); }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .pill { font-size: 11px; padding: 2px 7px; border-radius: 999px; font-weight: 600; white-space: nowrap; }
  .st-running { background: rgba(56,139,253,.2); color: #79c0ff; }
  .st-ok { background: rgba(63,185,80,.2); color: #56d364; }
  .st-timeout { background: rgba(210,153,34,.2); color: #e3b341; }
  .st-error { background: rgba(248,81,73,.2); color: #ff7b72; }
  .meta-line { font-size: 12px; color: var(--muted); margin-top: 4px; word-break: break-all; }
  .box { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .box h3 { margin: 0 0 8px 0; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .bar-wrap { height: 7px; background: rgba(127, 127, 127, 0.2); border-radius: 4px; overflow: hidden; margin-top: 8px; }
  .bar-fill { height: 100%; background: var(--accent); transition: width .3s; }
  .ev { padding: 6px 9px; border-left: 3px solid var(--border); margin-bottom: 6px; background: var(--panel-alt); border-radius: 4px; font-size: 12px; }
  .ev.kind-tool_call { border-color: var(--accent); }
  .ev.kind-tool_result { border-color: var(--ok); }
  .ev.kind-thinking { border-color: #a371f7; }
  .ev.kind-error { border-color: var(--err); }
  .ev-title { font-weight: 600; font-size: 12px; }
  .ev-detail { color: var(--muted); font-size: 12px; margin-top: 2px; white-space: pre-wrap; word-break: break-word; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: var(--text); opacity: 0.92; }
</style>
</head>
<body>
<header>
  <h1>Agent Dispatch 实时看板</h1>
  <div class="sub" id="refreshInfo">1.5s 自动刷新</div>
</header>
<div class="compact-bar">
  <select id="runSelect" aria-label="选择运行记录"></select>
</div>
<div class="layout">
  <div class="sidebar" id="runList">加载中...</div>
  <div class="main" id="detail"><div class="meta-line">正在加载派发记录...</div></div>
</div>
<script>
let selectedId = null;
function esc(s){ return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtDur(ms){ const s=Math.round((ms||0)/1000); return s>=60 ? Math.floor(s/60)+'m '+ (s%60)+'s' : s+'s'; }
async function apiFetch(url){
  const f = window.sidecar && window.sidecar.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
  return f(url, { method: 'GET' });
}

document.getElementById('runSelect').addEventListener('change', (e) => {
  if (e.target.value) selectRun(e.target.value);
});

async function loadRuns(){
  try {
    const res = await apiFetch('/api/runs');
    const data = await res.json();
    const list = document.getElementById('runList');
    const select = document.getElementById('runSelect');
    if(!data.runs || !data.runs.length){
      list.innerHTML = '<div class="meta-line">暂无派发记录</div>';
      select.innerHTML = '<option value="">暂无派发记录</option>';
      document.getElementById('detail').innerHTML = '<div class="meta-line">暂无派发记录，派发任务后这里会自动实时更新。</div>';
      return;
    }
    if(!selectedId || !data.runs.some(r => r.runId === selectedId)) {
      const running = data.runs.find(r => r.status === 'running');
      selectedId = running ? running.runId : data.runs[0].runId;
    }
    select.innerHTML = data.runs.map(r => \`<option value="\${esc(r.runId)}" \${r.runId===selectedId?'selected':''}>\${esc(r.worker.toUpperCase())} · \${esc(r.status)} · \${esc(r.runId)} (\${fmtDur(r.elapsedMs)})</option>\`).join('');
    list.innerHTML = data.runs.map(r => \`
      <div class="run-card \${r.runId===selectedId?'active':''}" onclick="selectRun('\${esc(r.runId)}')">
        <div class="row">
          <strong>\${esc(r.worker.toUpperCase())}</strong>
          <span class="pill st-\${esc(r.status)}">\${esc(r.status)}\${r.status==='running'&&r.isAlive?' ●':''}</span>
        </div>
        <div class="meta-line">\${esc(r.runId)}</div>
        <div class="meta-line">模型: \${esc(r.model||'默认')} · 强度: \${esc(r.effort||'默认')} · 工具: \${r.toolCalls} · \${fmtDur(r.elapsedMs)}</div>
        <div class="meta-line">\${esc(r.cwd)}</div>
      </div>\`).join('');
    if(selectedId) await loadDetail(selectedId);
  } catch (err) {
    document.getElementById('refreshInfo').textContent = '刷新异常: ' + (err.message || err);
  }
}

async function selectRun(id){ selectedId = id; await loadRuns(); }

async function loadDetail(id){
  const res = await apiFetch('/api/run?id=' + encodeURIComponent(id));
  if(!res.ok) return;
  const d = await res.json();
  const m = d.meta;
  const elapsed = m.status==='running' && m.startedAt ? Math.max(0, Date.now()-Date.parse(m.startedAt)) : (m.durationMs||0);
  const pct = m.timeoutSec ? Math.min(100, Math.round((elapsed/1000)/m.timeoutSec*100)) : 0;
  const eventsHtml = (d.events||[]).slice().reverse().map(e => \`
    <div class="ev kind-\${esc(e.kind)}">
      <div class="ev-title">#\${e.index} · \${esc(e.title)}</div>
      \${e.detail ? '<div class="ev-detail">'+esc(e.detail)+'</div>' : ''}
    </div>\`).join('') || '<div class="meta-line">暂无事件输出（等待首个步骤提交）</div>';

  document.getElementById('detail').innerHTML = \`
    <div class="box">
      <div class="row">
        <strong style="font-size:14px">\${esc(m.runId)}</strong>
        <span class="pill st-\${esc(m.status)}">\${esc(m.status)}</span>
      </div>
      <div class="meta-line">执行器: \${esc(m.worker)} · 模式: \${esc(m.mode)} · 档位: \${esc(m.tier||'-')} · 模型: \${esc(m.model||'默认')} · 思考强度: \${esc(m.effort||'默认')}</div>
      <div class="meta-line">目录: \${esc(m.effectiveCwd)} · Session: \${esc(d.sessionId||m.sessionId||'-')}</div>
      <div class="meta-line">耗时: \${fmtDur(elapsed)} / 上限 \${m.timeoutSec||600}s · 工具调用: \${d.toolCalls}</div>
      <div class="bar-wrap"><div class="bar-fill" style="width:\${pct}%"></div></div>
    </div>
    \${m.summary ? '<div class="box"><h3>最终结论摘要</h3><pre>'+esc(m.summary)+'</pre></div>' : ''}
    \${(m.changedFiles&&m.changedFiles.length) ? '<div class="box"><h3>改动文件 ('+m.changedFiles.length+')</h3><pre>'+esc(m.changedFiles.join('\\n'))+'</pre></div>' : ''}
    <div class="box"><h3>实时步骤时间线（最新在上）</h3>\${eventsHtml}</div>
    \${d.stderrTail ? '<div class="box"><h3>Stderr 日志尾部</h3><pre>'+esc(d.stderrTail)+'</pre></div>' : ''}
    \${d.diffPreview ? '<div class="box"><h3>Diff 预览</h3><pre>'+esc(d.diffPreview)+'</pre></div>' : ''}
  \`;
}

loadRuns();
setInterval(loadRuns, 1500);
</script>
</body>
</html>`;
}

/**
 * Create a pure Node HTTP server serving the live Agent Dispatch dashboard and JSON API.
 * @param {{ stateDir: string }} options
 */
export function createDashboardServer({ stateDir }) {
  return http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHtml({ includePreload: false }));
      return;
    }

    if (pathname === '/api/runs') {
      sendJson(res, 200, getRunsPayload(stateDir));
      return;
    }

    if (pathname === '/api/run') {
      const runId = reqUrl.searchParams.get('id');
      if (!runId) {
        sendJson(res, 400, { error: 'Missing id query parameter' });
        return;
      }
      try {
        sendJson(res, 200, getRunDetailPayload(stateDir, runId));
      } catch (err) {
        sendJson(res, 404, { error: err?.message || 'Run not found' });
      }
      return;
    }

    if (pathname.startsWith('/api/runs/')) {
      const runId = decodeURIComponent(pathname.slice('/api/runs/'.length));
      try {
        sendJson(res, 200, getRunDetailPayload(stateDir, runId));
      } catch (err) {
        sendJson(res, 404, { error: err?.message || 'Run not found' });
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });
}

/**
 * Start listening for the live dashboard server.
 * @param {{ stateDir: string, host?: string, port?: number }} options
 */
export function startDashboard({ stateDir, host = '127.0.0.1', port = 4310 }) {
  const server = createDashboardServer({ stateDir });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
      });
    });
  });
}
