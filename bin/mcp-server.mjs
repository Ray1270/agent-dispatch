#!/usr/bin/env node
import readline from 'node:readline';
import { handleMcpMessage } from '../src/mcp.mjs';

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function writeFrame(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    writeFrame({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `Parse error: ${err?.message || err}` },
    });
    return;
  }

  try {
    const response = await handleMcpMessage(msg);
    if (response) {
      writeFrame(response);
    }
  } catch (err) {
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id')) {
      writeFrame({
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: { code: -32603, message: err?.message || String(err) },
      });
    }
  }
});
