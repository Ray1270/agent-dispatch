import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installForTarget } from '../src/installer.mjs';

test('installer generates portable configs for antigravity, claude-code, cursor, gemini-cli, and mcp-config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-install-'));
  try {
    const agyDir = path.join(root, 'antigravity');
    const agyRes = installForTarget({ target: 'antigravity', targetDir: agyDir });
    assert.equal(agyRes.writtenFiles.length, 5);
    const agySkill = fs.readFileSync(path.join(agyDir, 'skills', 'agent-dispatch', 'SKILL.md'), 'utf8');
    const agyMain = fs.readFileSync(path.join(agyDir, 'sidecars', 'dashboard', 'main.mjs'), 'utf8');
    assert.equal(agySkill.includes('<AGENT_DISPATCH_ROOT>'), false);
    assert.equal(agyMain.includes('<AGENT_DISPATCH_ROOT>'), false);

    const claudeDir = path.join(root, 'claude');
    const claudeRes = installForTarget({ target: 'claude-code', targetDir: claudeDir });
    assert.equal(fs.existsSync(path.join(claudeDir, 'SKILL.md')), true);
    assert.ok(claudeRes.mcpConfig.mcpServers['agent-dispatch'].args[0].endsWith('bin/mcp-server.mjs'));

    const cursorDir = path.join(root, 'cursor-ws');
    installForTarget({ target: 'cursor', targetDir: cursorDir });
    const mdc = fs.readFileSync(path.join(cursorDir, '.cursor', 'rules', 'agent-dispatch.mdc'), 'utf8');
    assert.ok(mdc.includes('alwaysApply: true'));
    assert.equal(mdc.includes('<AGENT_DISPATCH_ROOT>'), false);

    const geminiDir = path.join(root, 'gemini');
    installForTarget({ target: 'gemini-cli', targetDir: geminiDir });
    assert.equal(fs.existsSync(path.join(geminiDir, 'SKILL.md')), true);

    const mcpOnly = installForTarget({ target: 'mcp-config' });
    assert.equal(mcpOnly.writtenFiles.length, 0);
    assert.equal(mcpOnly.mcpConfig.mcpServers['agent-dispatch'].command, 'node');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
