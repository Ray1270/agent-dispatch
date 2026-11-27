#!/usr/bin/env node
import fs from 'node:fs';
import { ensureUserConfig, getStateDir, loadConfig } from '../src/config.mjs';
import { startDashboard } from '../src/dashboard.mjs';
import { runDoctor } from '../src/discovery.mjs';
import { isPidAlive, parseLiveRunProgress } from '../src/events.mjs';
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
  const text = `agent-dispatch - Analyze, route, execute, monitor, and archive codex / dsh tasks

Usage:
  dispatch doctor
  dispatch route --task <text> [--task-file <path>] [--cwd <dir>] [--files-count <n>] [--risk low|medium|high] [--mode readonly|inplace|worktree] [--worker self|codex|dsh] [--model <id>] [--effort <level>]
  dispatch run --worker codex|dsh (--task <text> | --task-file <path>) [--cwd <dir>] [--mode readonly|inplace|worktree] [--tier light|standard|heavy] [--timeout <sec>] [--model <id>] [--effort <level>] [--constraint <text>] [--no-dsh-stored-auth] [--dry-run]
  dispatch resume --run-id <id> (--task <text> | --task-file <path>) [--timeout <sec>] [--model <id>] [--effort <level>] [--constraint <text>] [--dry-run]
  dispatch inspect --run-id <id>
  dispatch list [--limit <n>]
  dispatch watch [--run-id <id>] [--interval <ms>]
  dispatch ui [--port <n>] [--host <ip>]
  dispatch cleanup-worktree --run-id <id> [--force-branch]
`;
  process.stdout.write(text);
}

async function runWatch(stateDir, runIdFlag, intervalMs) {
  let targetId = runIdFlag ? String(runIdFlag) : null;
  if (!targetId) {
    const runs = listRuns(stateDir, 20);
    const active = runs.find((r) => r.status === 'running') || runs[0];
    if (!active) {
      throw new Error('No runs found to watch.');
    }
    targetId = active.runId;
  }

  let seenIndex = 0;
  process.stdout.write(`Watching run ${targetId}...\n`);
  while (true) {
    const meta = loadRunMeta(stateDir, targetId);
    const progress = parseLiveRunProgress(meta, { maxEvents: 500 });
    for (const ev of progress.events) {
      if (ev.index > seenIndex) {
        seenIndex = ev.index;
        const suffix = ev.detail ? `: ${ev.detail}` : '';
        process.stdout.write(`[#${ev.index} ${ev.kind}] ${ev.title}${suffix}\n`);
      }
    }
    if (meta.status !== 'running') {
      process.stdout.write(
        `\nFinished: status=${meta.status} durationMs=${meta.durationMs} toolCalls=${meta.toolCalls ?? progress.toolCalls}\n`
      );
      process.exitCode = meta.status === 'ok' ? 0 : 1;
      return;
    }
    if (meta.pid && !isPidAlive(meta.pid)) {
      process.stdout.write('\nProcess no longer alive while meta.status=running.\n');
      process.exitCode = 1;
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
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
        model: typeof flags.model === 'string' ? flags.model : undefined,
        effort: typeof flags.effort === 'string' ? flags.effort : undefined,
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
      tier: typeof flags.tier === 'string' ? flags.tier : undefined,
      timeoutSec: flags.timeout !== undefined ? Number(flags.timeout) : undefined,
      model: typeof flags.model === 'string' ? flags.model : undefined,
      effort: typeof flags.effort === 'string' ? flags.effort : undefined,
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
      effort: typeof flags.effort === 'string' ? flags.effort : undefined,
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

  if (command === 'watch') {
    const intervalMs = flags.interval !== undefined ? Math.max(300, Number(flags.interval)) : 1500;
    await runWatch(stateDir, flags['run-id'], intervalMs);
    return;
  }

  if (command === 'ui') {
    const port = flags.port !== undefined ? Number(flags.port) : Number(config?.defaults?.dashboardPort ?? 4310);
    const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
    const { url } = await startDashboard({ stateDir, host, port });
    process.stdout.write(JSON.stringify({ url, host, port, stateDir }, null, 2) + '\n');
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
