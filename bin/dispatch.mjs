#!/usr/bin/env node
import fs from 'node:fs';
import { ensureUserConfig, getStateDir, loadConfig } from '../src/config.mjs';
import { runDoctor } from '../src/discovery.mjs';
import { cleanupRunWorktree, executeResume, executeRun } from '../src/execute.mjs';
import { recommendRoute } from '../src/router.mjs';
import { listRuns, loadRunMeta } from '../src/store.mjs';

function parseCliArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const eqIndex = token.indexOf('=');
    let key;
    let val;
    if (eqIndex !== -1) {
      key = token.slice(2, eqIndex);
      val = token.slice(eqIndex + 1);
    } else {
      key = token.slice(2);
      const next = argv[i + 1];
      if (
        key === 'dry-run' ||
        key === 'no-dsh-stored-auth' ||
        key === 'force-branch' ||
        key === 'help'
      ) {
        val = true;
      } else if (next !== undefined && !next.startsWith('--')) {
        val = next;
        i += 1;
      } else {
        val = true;
      }
    }

    if (key === 'constraint') {
      if (!Array.isArray(flags.constraint)) flags.constraint = [];
      flags.constraint.push(String(val));
    } else {
      flags[key] = val;
    }
  }
  return { command: positionals[0] || 'help', positionals: positionals.slice(1), flags };
}

function readTaskFromFlags(flags) {
  if (flags['task-file']) {
    return fs.readFileSync(String(flags['task-file']), 'utf8');
  }
  if (typeof flags.task === 'string') {
    return flags.task;
  }
  return '';
}

function printJson(obj, exitCode = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exitCode = exitCode;
}

function printHelp() {
  const text = `agent-dispatch - Analyze, route, execute, and archive codex / dsh tasks

Usage:
  dispatch doctor
  dispatch route --task <text> [--task-file <path>] [--cwd <dir>] [--files-count <n>] [--risk low|medium|high] [--mode readonly|inplace|worktree] [--worker self|codex|dsh]
  dispatch run --worker codex|dsh (--task <text> | --task-file <path>) [--cwd <dir>] [--mode readonly|inplace|worktree] [--timeout <sec>] [--model <name>] [--constraint <text>] [--no-dsh-stored-auth] [--dry-run]
  dispatch resume --run-id <id> (--task <text> | --task-file <path>) [--timeout <sec>] [--model <name>] [--constraint <text>] [--dry-run]
  dispatch inspect --run-id <id>
  dispatch list [--limit <n>]
  dispatch cleanup-worktree --run-id <id> [--force-branch]
`;
  process.stdout.write(text);
}

async function main() {
  const { command, flags } = parseCliArgs(process.argv.slice(2));
  if (command === 'help' || flags.help) {
    printHelp();
    return;
  }

  const stateDir = getStateDir();
  ensureUserConfig(stateDir);
  const config = loadConfig(stateDir);

  if (command === 'doctor') {
    const report = runDoctor(config);
    printJson(report, report.ok ? 0 : 1);
    return;
  }

  if (command === 'route') {
    const task = readTaskFromFlags(flags);
    const recommendation = recommendRoute(
      {
        task,
        cwd: flags.cwd,
        filesCount: flags['files-count'] !== undefined ? Number(flags['files-count']) : undefined,
        risk: flags.risk,
        forceWorker: flags.worker,
        mode: flags.mode,
      },
      config
    );
    printJson(recommendation, 0);
    return;
  }

  if (command === 'run') {
    const task = readTaskFromFlags(flags);
    const result = await executeRun({
      worker: flags.worker,
      cwd: flags.cwd,
      mode: flags.mode,
      timeoutSec: flags.timeout !== undefined ? Number(flags.timeout) : undefined,
      model: typeof flags.model === 'string' ? flags.model : undefined,
      task,
      constraints: Array.isArray(flags.constraint) ? flags.constraint : [],
      useDshStoredAuth: flags['no-dsh-stored-auth'] ? false : undefined,
      dryRun: Boolean(flags['dry-run']),
    });
    const code = result.dryRun || result.status === 'ok' ? 0 : 1;
    printJson(result, code);
    return;
  }

  if (command === 'resume') {
    if (!flags['run-id']) {
      throw new Error('--run-id is required for resume');
    }
    const task = readTaskFromFlags(flags);
    const result = await executeResume({
      runId: String(flags['run-id']),
      task,
      timeoutSec: flags.timeout !== undefined ? Number(flags.timeout) : undefined,
      model: typeof flags.model === 'string' ? flags.model : undefined,
      constraints: Array.isArray(flags.constraint) ? flags.constraint : [],
      dryRun: Boolean(flags['dry-run']),
    });
    const code = result.dryRun || result.status === 'ok' ? 0 : 1;
    printJson(result, code);
    return;
  }

  if (command === 'inspect') {
    if (!flags['run-id']) {
      throw new Error('--run-id is required for inspect');
    }
    const meta = loadRunMeta(stateDir, String(flags['run-id']));
    printJson(meta, 0);
    return;
  }

  if (command === 'list') {
    const limit = flags.limit !== undefined ? Number(flags.limit) : 20;
    const runs = listRuns(stateDir, limit);
    printJson({ count: runs.length, runs }, 0);
    return;
  }

  if (command === 'cleanup-worktree') {
    if (!flags['run-id']) {
      throw new Error('--run-id is required for cleanup-worktree');
    }
    const res = cleanupRunWorktree(String(flags['run-id']), Boolean(flags['force-branch']));
    printJson(res, 0);
    return;
  }

  throw new Error(`Unknown command "${command}". Run with --help for usage.`);
}

main().catch((err) => {
  printJson({ error: err?.message || String(err) }, 1);
});
