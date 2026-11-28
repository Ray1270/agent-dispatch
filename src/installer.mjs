import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectRoot } from './config.mjs';

function toPortableSlashes(p) {
  return String(p).replaceAll('\\', '/');
}

function renderTemplate(templatePath, rootForSubstitution) {
  const raw = fs.readFileSync(templatePath, 'utf8');
  return raw.replaceAll('<AGENT_DISPATCH_ROOT>', toPortableSlashes(rootForSubstitution));
}

function writeTargetFile(destPath, content, dryRun) {
  if (!dryRun) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, content, 'utf8');
  }
  return destPath;
}

/**
 * Generate a ready-to-paste MCP server configuration snippet for any MCP client.
 * @param {string} [projectRoot]
 */
export function buildMcpConfigSnippet(projectRoot = getProjectRoot()) {
  const serverPath = toPortableSlashes(path.join(projectRoot, 'bin', 'mcp-server.mjs'));
  return {
    mcpServers: {
      'agent-dispatch': {
        command: 'node',
        args: [serverPath],
      },
    },
  };
}

/**
 * Install agent-dispatch integration files for a host platform.
 * Supported targets: antigravity, claude-code, cursor, gemini-cli, codex, mcp-config.
 * @param {{ target: string, targetDir?: string, dryRun?: boolean, projectRoot?: string }} options
 */
export function installForTarget({
  target,
  targetDir,
  dryRun = false,
  projectRoot = getProjectRoot(),
}) {
  const home = os.homedir();
  const rootSlash = toPortableSlashes(projectRoot);
  const mcpConfig = buildMcpConfigSnippet(projectRoot);
  const writtenFiles = [];

  if (target === 'mcp-config') {
    return {
      target,
      dryRun,
      writtenFiles,
      mcpConfig,
      notes: [
        'Paste the mcpServers snippet into your client MCP configuration (Claude Code, Claude Desktop, Cursor, Windsurf, Cline, Cherry Studio, etc.).',
      ],
    };
  }

  if (target === 'antigravity') {
    const baseDir = targetDir
      ? path.resolve(targetDir)
      : path.join(home, '.gemini', 'config', 'plugins', 'agent-dispatch');
    const pluginDir = path.join(projectRoot, 'plugin');

    const files = [
      {
        src: path.join(pluginDir, 'plugin.json'),
        dest: path.join(baseDir, 'plugin.json'),
      },
      {
        src: path.join(pluginDir, 'rules', 'AGENTS.md'),
        dest: path.join(baseDir, 'rules', 'AGENTS.md'),
      },
      {
        src: path.join(pluginDir, 'skills', 'agent-dispatch', 'SKILL.md'),
        dest: path.join(baseDir, 'skills', 'agent-dispatch', 'SKILL.md'),
      },
      {
        src: path.join(pluginDir, 'sidecars', 'dashboard', 'sidecar.json'),
        dest: path.join(baseDir, 'sidecars', 'dashboard', 'sidecar.json'),
      },
      {
        src: path.join(pluginDir, 'sidecars', 'dashboard', 'main.mjs'),
        dest: path.join(baseDir, 'sidecars', 'dashboard', 'main.mjs'),
      },
    ];

    for (const f of files) {
      writtenFiles.push(writeTargetFile(f.dest, renderTemplate(f.src, rootSlash), dryRun));
    }

    return {
      target,
      dryRun,
      installDir: baseDir,
      writtenFiles,
      notes: [
        'Antigravity plugin installed (includes always-on rule, agent-dispatch skill, and side-pane Dispatch 看板 sidecar).',
        'Toggle the plugin off/on in Antigravity Customizations (or restart) if the sidecar process has not started yet.',
      ],
    };
  }

  if (target === 'claude-code') {
    const baseDir = targetDir
      ? path.resolve(targetDir)
      : path.join(home, '.claude', 'skills', 'agent-dispatch');
    const dest = path.join(baseDir, 'SKILL.md');
    const content = renderTemplate(path.join(projectRoot, 'skill', 'SKILL.md'), rootSlash);
    writtenFiles.push(writeTargetFile(dest, content, dryRun));
    return {
      target,
      dryRun,
      installDir: baseDir,
      writtenFiles,
      mcpConfig,
      notes: [
        'Skill installed for Claude Code. Optionally register the MCP server in ~/.claude.json or .mcp.json using the mcpConfig snippet.',
      ],
    };
  }

  if (target === 'gemini-cli') {
    const baseDir = targetDir
      ? path.resolve(targetDir)
      : path.join(home, '.gemini', 'skills', 'agent-dispatch');
    const dest = path.join(baseDir, 'SKILL.md');
    const content = renderTemplate(path.join(projectRoot, 'skill', 'SKILL.md'), rootSlash);
    writtenFiles.push(writeTargetFile(dest, content, dryRun));
    return {
      target,
      dryRun,
      installDir: baseDir,
      writtenFiles,
      mcpConfig,
      notes: [
        'Skill installed for Gemini CLI. Optionally add the mcpConfig snippet to ~/.gemini/settings.json.',
      ],
    };
  }

  if (target === 'codex') {
    const baseDir = targetDir
      ? path.resolve(targetDir)
      : path.join(home, '.codex', 'skills', 'agent-dispatch');
    const dest = path.join(baseDir, 'SKILL.md');
    const content = renderTemplate(path.join(projectRoot, 'skill', 'SKILL.md'), rootSlash);
    writtenFiles.push(writeTargetFile(dest, content, dryRun));
    return {
      target,
      dryRun,
      installDir: baseDir,
      writtenFiles,
      notes: ['Skill installed for Codex CLI.'],
    };
  }

  if (target === 'cursor') {
    const workspaceRoot = targetDir ? path.resolve(targetDir) : process.cwd();
    const ruleDest = path.join(workspaceRoot, '.cursor', 'rules', 'agent-dispatch.mdc');
    const rulesBody = fs.readFileSync(path.join(projectRoot, 'plugin', 'rules', 'AGENTS.md'), 'utf8');
    const mdc = [
      '---',
      'description: Analyze medium/large coding, refactoring, test, script, and research tasks and dispatch to external CLI agents via agent-dispatch.',
      'alwaysApply: true',
      '---',
      '',
      rulesBody.trim(),
      '',
      '## CLI Entrypoint',
      `- Route: \`node "${rootSlash}/bin/dispatch.mjs" route --cwd "<workspace>" --task "<summary>"\``,
      `- Run: \`node "${rootSlash}/bin/dispatch.mjs" run --worker <codex|dsh|claude|gemini|qwen> --mode <readonly|inplace|worktree> --cwd "<workspace>" --task-file "<brief>"\``,
      `- Live Dashboard: \`node "${rootSlash}/bin/dispatch.mjs" ui\``,
      '',
    ].join('\n');
    writtenFiles.push(writeTargetFile(ruleDest, mdc, dryRun));
    return {
      target,
      dryRun,
      installDir: path.join(workspaceRoot, '.cursor', 'rules'),
      writtenFiles,
      mcpConfig,
      notes: [
        'Cursor rule installed at .cursor/rules/agent-dispatch.mdc. Optionally merge mcpConfig into .cursor/mcp.json.',
      ],
    };
  }

  throw new Error(
    `Unknown install target "${target}". Supported: antigravity, claude-code, cursor, gemini-cli, codex, mcp-config.`
  );
}
