import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { handleMcpMessage, MCP_TOOLS } from '../src/mcp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MCP_SERVER_BIN = path.join(PROJECT_ROOT, 'bin', 'mcp-server.mjs');

test('handleMcpMessage supports initialize, notification, tools/list, and dryRun tools/call', async () => {
  const tempState = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-mcp-'));
  const prevHome = process.env.AGENT_DISPATCH_HOME;
  process.env.AGENT_DISPATCH_HOME = tempState;
  try {
    const initRes = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    assert.equal(initRes.result.serverInfo.name, 'agent-dispatch');

    const notifRes = await handleMcpMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    assert.equal(notifRes, null);

    const listRes = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(listRes.result.tools.length, MCP_TOOLS.length);

    const routeRes = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'dispatch_route',
        arguments: { task: '重构认证模块并写测试', cwd: PROJECT_ROOT },
      },
    });
    assert.equal(routeRes.result.isError, false);
    assert.equal(routeRes.result.structuredContent.worker, 'codex');

    const dummyCli = path.join(tempState, 'mock-claude.js');
    fs.writeFileSync(dummyCli, 'console.log("ok");\n', 'utf8');
    const prevClaude = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = dummyCli;
    try {
      const dryRunRes = await handleMcpMessage({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'dispatch_run',
          arguments: {
            worker: 'claude',
            mode: 'readonly',
            cwd: PROJECT_ROOT,
            task: 'Inspect code',
            dryRun: true,
          },
        },
      });
      assert.equal(dryRunRes.result.isError, false);
      assert.equal(dryRunRes.result.structuredContent.dryRun, true);
      assert.equal(dryRunRes.result.structuredContent.worker, 'claude');
    } finally {
      if (prevClaude === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = prevClaude;
    }
  } finally {
    if (prevHome === undefined) delete process.env.AGENT_DISPATCH_HOME;
    else process.env.AGENT_DISPATCH_HOME = prevHome;
    fs.rmSync(tempState, { recursive: true, force: true });
  }
});

test('bin/mcp-server.mjs completes real stdio JSON-RPC round-trip', async () => {
  const tempState = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-mcp-stdio-'));
  try {
    const responses = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [MCP_SERVER_BIN], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, AGENT_DISPATCH_HOME: tempState },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const lines = [];
      let buf = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('MCP server stdio round-trip timed out'));
      }, 6000);

      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) lines.push(JSON.parse(line));
          if (lines.length === 2) {
            clearTimeout(timer);
            child.kill();
            resolve(lines);
          }
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n'
      );
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
      child.stdin.end();
    });

    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.serverInfo.name, 'agent-dispatch');
    assert.equal(responses[1].id, 2);
    assert.ok(responses[1].result.tools.some((t) => t.name === 'dispatch_run'));
  } finally {
    fs.rmSync(tempState, { recursive: true, force: true });
  }
});
