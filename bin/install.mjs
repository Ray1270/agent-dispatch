#!/usr/bin/env node
import { installForTarget } from '../src/installer.mjs';

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
    } else {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (key === 'dry-run' || key === 'help') {
        flags[key] = true;
      } else if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    }
  }
  return { target: positionals[0] || 'help', flags };
}

function printHelp() {
  process.stdout.write(`agent-dispatch-install - Install agent-dispatch across host platforms

Usage:
  node bin/install.mjs <target> [--target-dir <dir>] [--dry-run]

Targets:
  antigravity   Install full Antigravity plugin (rule + skill + side-pane dashboard)
  claude-code   Install skill for Claude Code + print MCP server snippet
  cursor        Install .cursor/rules/agent-dispatch.mdc in workspace + print MCP snippet
  gemini-cli    Install skill for Gemini CLI + print MCP server snippet
  codex         Install skill for Codex CLI
  mcp-config    Print universal stdio MCP server config JSON
`);
}

function main() {
  const { target, flags } = parseArgs(process.argv.slice(2));
  if (target === 'help' || flags.help) {
    printHelp();
    return;
  }

  const res = installForTarget({
    target,
    targetDir: typeof flags['target-dir'] === 'string' ? flags['target-dir'] : undefined,
    dryRun: Boolean(flags['dry-run']),
  });
  process.stdout.write(JSON.stringify(res, null, 2) + '\n');
}

try {
  main();
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err?.message || String(err) }, null, 2) + '\n');
  process.exitCode = 1;
}
