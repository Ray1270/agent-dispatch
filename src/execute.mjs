import fs from 'node:fs';
import path from 'node:path';
import { buildCodexArgs, parseCodexJsonl } from './adapters/codex.mjs';
import { buildDshArgs, parseDshJsonl } from './adapters/dsh.mjs';
import { ensureUserConfig, getDshAuthPatchPath, getStateDir, loadConfig } from './config.mjs';
import { resolveCodexBinary, resolveDshBinary } from './discovery.mjs';
import { buildWorkerPrompt } from './prompt.mjs';
import { runProcess } from './runner.mjs';
import { createRunDir, generateRunId, loadRunMeta, saveRunMeta } from './store.mjs';
import {
  captureFsSnapshot,
  computeGitChanges,
  createWorktree,
  diffFsSnapshots,
  getGitBaseline,
  isGitRepo,
  removeWorktree,
} from './workspace.mjs';

function resolveBackend(worker) {
  if (worker === 'codex') {
    const bin = resolveCodexBinary();
    if (!bin.found || !bin.command) {
      throw new Error(bin.error || 'Codex CLI not found.');
    }
    return { command: bin.command, argsPrefix: [], source: bin.source };
  }
  if (worker === 'dsh') {
    const bin = resolveDshBinary();
    if (!bin.found || !bin.command) {
      throw new Error(bin.error || 'dsh CLI not found.');
    }
    return { command: bin.command, argsPrefix: bin.argsPrefix || [], source: bin.source };
  }
  throw new Error(`Unsupported worker "${worker}". Expected "codex" or "dsh".`);
}

export function determineStatus({ timedOut, exitCode, errors, turnEndReason }) {
  if (timedOut) return 'timeout';
  if (exitCode !== 0) return 'error';
  if (errors && errors.length > 0) return 'error';
  const reasonKind = typeof turnEndReason === 'string' ? turnEndReason : turnEndReason?.kind;
  if (reasonKind === 'error' || reasonKind === 'aborted' || reasonKind === 'cancelled') {
    return 'error';
  }
  return 'ok';
}

/**
 * Execute a new worker run or dry-run.
 * @param {object} params
 */
export async function executeRun(params) {
  const stateDir = getStateDir();
  ensureUserConfig(stateDir);
  const config = loadConfig(stateDir);

  const worker = params.worker;
  if (worker !== 'codex' && worker !== 'dsh') {
    throw new Error(`--worker must be "codex" or "dsh" (received "${worker}")`);
  }

  const cwd = path.resolve(params.cwd || process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Target --cwd does not exist or is not a directory: ${cwd}`);
  }

  const mode = params.mode || 'inplace';
  if (!['readonly', 'inplace', 'worktree'].includes(mode)) {
    throw new Error(`Invalid --mode "${mode}". Must be readonly, inplace, or worktree.`);
  }

  const task = String(params.task || '').trim();
  if (!task) {
    throw new Error('Task cannot be empty. Provide --task or --task-file.');
  }

  const maxTimeoutSec = Number(config?.defaults?.maxTimeoutSec ?? 1800);
  const defaultTimeoutSec = Number(config?.defaults?.timeoutSec ?? 600);
  const timeoutSec = Math.min(
    maxTimeoutSec,
    Math.max(10, Number(params.timeoutSec || defaultTimeoutSec))
  );

  const model = params.model ?? config?.models?.[worker] ?? null;
  const useStoredCredentials =
    params.useDshStoredAuth !== undefined
      ? Boolean(params.useDshStoredAuth)
      : Boolean(config?.defaults?.useDshStoredCredentials ?? true);
  const authPatchPath = getDshAuthPatchPath();

  const gitRepo = isGitRepo(cwd);
  if (mode === 'worktree' && !gitRepo) {
    throw new Error(`Cannot use --mode worktree because ${cwd} is not a Git repository.`);
  }

  const backend = resolveBackend(worker);
  const warnings = [];
  if (worker === 'dsh' && model) {
    warnings.push(`dsh headless profile does not support CLI --model override; ignoring "${model}" and using profile default.`);
  }

  if (params.dryRun) {
    const previewPrompt = buildWorkerPrompt({
      task,
      mode,
      isGit: gitRepo,
      cwd,
      constraints: params.constraints,
    });
    const fakeLastMsg = path.join(stateDir, 'runs', '<run-id>', 'last-message.txt');
    const args =
      worker === 'codex'
        ? buildCodexArgs({ cwd, mode, isGit: gitRepo, model, sessionId: null, lastMessageFile: fakeLastMsg })
        : buildDshArgs({
            argsPrefix: backend.argsPrefix,
            useStoredCredentials,
            authPatchPath,
            sessionId: null,
          });
    return {
      dryRun: true,
      worker,
      mode,
      isGit: gitRepo,
      cwd,
      effectiveCwd: mode === 'worktree' ? path.join(stateDir, 'worktrees', '<run-id>') : cwd,
      command: backend.command,
      args,
      timeoutSec,
      useStoredCredentials: worker === 'dsh' ? useStoredCredentials : undefined,
      warnings,
      promptPreview: previewPrompt,
    };
  }

  const runId = generateRunId(worker);
  const runDir = createRunDir(stateDir, runId);
  const stdoutFile = path.join(runDir, 'stdout.jsonl');
  const stderrFile = path.join(runDir, 'stderr.log');
  const lastMessageFile = path.join(runDir, 'last-message.txt');
  const promptFile = path.join(runDir, 'prompt.md');

  let effectiveCwd = cwd;
  let worktreeInfo = null;
  let gitBaseline = null;
  let beforeSnapshot = null;

  if (gitRepo) {
    if (mode === 'worktree') {
      worktreeInfo = createWorktree(cwd, runId, stateDir);
      effectiveCwd = worktreeInfo.worktreePath;
      if (worktreeInfo.warning) warnings.push(worktreeInfo.warning);
      gitBaseline = getGitBaseline(effectiveCwd);
    } else {
      gitBaseline = getGitBaseline(cwd);
    }
  } else {
    if (mode !== 'readonly') {
      warnings.push('非 Git 目录写操作：已启用执行前后文件快照对比，不支持 Git 自动回滚。');
    }
    beforeSnapshot = captureFsSnapshot(cwd);
  }

  const fullPrompt = buildWorkerPrompt({
    task,
    mode,
    isGit: gitRepo,
    cwd: effectiveCwd,
    constraints: params.constraints,
  });
  fs.writeFileSync(promptFile, fullPrompt, 'utf8');

  const args =
    worker === 'codex'
      ? buildCodexArgs({
          cwd: effectiveCwd,
          mode,
          isGit: gitRepo,
          model,
          sessionId: null,
          lastMessageFile,
        })
      : buildDshArgs({
          argsPrefix: backend.argsPrefix,
          useStoredCredentials,
          authPatchPath,
          sessionId: null,
        });

  const proc = await runProcess({
    command: backend.command,
    args,
    cwd: effectiveCwd,
    stdinText: fullPrompt,
    timeoutMs: timeoutSec * 1000,
    stdoutFile,
    stderrFile,
  });

  const lastMessageContent = fs.existsSync(lastMessageFile)
    ? fs.readFileSync(lastMessageFile, 'utf8')
    : '';
  const parsed =
    worker === 'codex'
      ? parseCodexJsonl(proc.stdout, lastMessageContent)
      : parseDshJsonl(proc.stdout);

  if (worker === 'dsh' && parsed.finalMessage && !fs.existsSync(lastMessageFile)) {
    fs.writeFileSync(lastMessageFile, parsed.finalMessage, 'utf8');
  }

  let changedFiles = [];
  let diffStat = '';
  let diffFile = null;

  if (gitRepo) {
    const gitChanges = computeGitChanges(effectiveCwd, gitBaseline);
    changedFiles = gitChanges.changedFiles;
    diffStat = gitChanges.diffStat;
    if (gitChanges.diffPatch) {
      diffFile = path.join(runDir, 'diff.patch');
      fs.writeFileSync(diffFile, gitChanges.diffPatch, 'utf8');
    }
  } else if (beforeSnapshot) {
    const afterSnapshot = captureFsSnapshot(cwd);
    const snapDiff = diffFsSnapshots(beforeSnapshot, afterSnapshot);
    changedFiles = snapDiff.changedFiles;
    diffStat = `+${snapDiff.added.length} ~${snapDiff.modified.length} -${snapDiff.deleted.length}`;
    diffFile = path.join(runDir, 'snapshot-diff.json');
    fs.writeFileSync(diffFile, JSON.stringify(snapDiff, null, 2) + '\n', 'utf8');
  }

  const status = determineStatus({
    timedOut: proc.timedOut,
    exitCode: proc.exitCode,
    errors: parsed.errors,
    turnEndReason: parsed.turnEndReason,
  });

  const result = {
    runId,
    parentRunId: null,
    worker,
    status,
    sessionId: parsed.sessionId,
    mode,
    isGit: gitRepo,
    cwd,
    effectiveCwd,
    worktreeBranch: worktreeInfo?.branch || null,
    worktreePath: worktreeInfo?.worktreePath || null,
    useStoredCredentials: worker === 'dsh' ? useStoredCredentials : null,
    exitCode: proc.exitCode,
    timedOut: proc.timedOut,
    durationMs: proc.durationMs,
    toolCalls: parsed.toolCalls,
    usage: parsed.usage,
    turnEndReason: parsed.turnEndReason || null,
    errors: parsed.errors,
    warnings,
    summary: parsed.finalMessage,
    changedFiles,
    diffStat,
    artifacts: {
      runDir,
      promptFile,
      stdoutFile,
      stderrFile,
      lastMessageFile: fs.existsSync(lastMessageFile) ? lastMessageFile : null,
      diffFile,
    },
    createdAt: new Date().toISOString(),
  };

  saveRunMeta(runDir, result);
  return result;
}

/**
 * Resume an existing run using its persisted sessionId and effectiveCwd.
 * @param {object} params
 */
export async function executeResume(params) {
  const stateDir = getStateDir();
  ensureUserConfig(stateDir);
  const config = loadConfig(stateDir);

  const parentMeta = loadRunMeta(stateDir, params.runId);
  if (!parentMeta.sessionId) {
    throw new Error(`Parent run ${params.runId} has no recorded sessionId and cannot be resumed.`);
  }

  const task = String(params.task || '').trim();
  if (!task) {
    throw new Error('Follow-up --task or --task-file is required for resume.');
  }

  const worker = parentMeta.worker;
  const effectiveCwd = parentMeta.effectiveCwd || parentMeta.cwd;
  if (!fs.existsSync(effectiveCwd)) {
    throw new Error(`Working directory for run ${params.runId} no longer exists: ${effectiveCwd}`);
  }

  const mode = parentMeta.mode || 'inplace';
  const gitRepo = Boolean(parentMeta.isGit);
  const model = params.model ?? config?.models?.[worker] ?? null;
  const useStoredCredentials =
    parentMeta.useStoredCredentials !== null && parentMeta.useStoredCredentials !== undefined
      ? Boolean(parentMeta.useStoredCredentials)
      : Boolean(config?.defaults?.useDshStoredCredentials ?? true);
  const authPatchPath = getDshAuthPatchPath();

  const maxTimeoutSec = Number(config?.defaults?.maxTimeoutSec ?? 1800);
  const defaultTimeoutSec = Number(config?.defaults?.timeoutSec ?? 600);
  const timeoutSec = Math.min(
    maxTimeoutSec,
    Math.max(10, Number(params.timeoutSec || defaultTimeoutSec))
  );

  const backend = resolveBackend(worker);
  const warnings = [];
  if (worker === 'dsh' && model) {
    warnings.push(`dsh headless profile does not support CLI --model override; ignoring "${model}".`);
  }

  if (params.dryRun) {
    const previewPrompt = buildWorkerPrompt({
      task,
      mode,
      isGit: gitRepo,
      cwd: effectiveCwd,
      constraints: params.constraints,
    });
    const fakeLastMsg = path.join(stateDir, 'runs', '<run-id>', 'last-message.txt');
    const args =
      worker === 'codex'
        ? buildCodexArgs({
            cwd: effectiveCwd,
            mode,
            isGit: gitRepo,
            model,
            sessionId: parentMeta.sessionId,
            lastMessageFile: fakeLastMsg,
          })
        : buildDshArgs({
            argsPrefix: backend.argsPrefix,
            useStoredCredentials,
            authPatchPath,
            sessionId: parentMeta.sessionId,
          });
    return {
      dryRun: true,
      resumeOf: params.runId,
      sessionId: parentMeta.sessionId,
      worker,
      mode,
      isGit: gitRepo,
      effectiveCwd,
      command: backend.command,
      args,
      timeoutSec,
      warnings,
      promptPreview: previewPrompt,
    };
  }

  const runId = generateRunId(worker);
  const runDir = createRunDir(stateDir, runId);
  const stdoutFile = path.join(runDir, 'stdout.jsonl');
  const stderrFile = path.join(runDir, 'stderr.log');
  const lastMessageFile = path.join(runDir, 'last-message.txt');
  const promptFile = path.join(runDir, 'prompt.md');

  const gitBaseline = gitRepo ? getGitBaseline(effectiveCwd) : null;
  const beforeSnapshot = gitRepo ? null : captureFsSnapshot(effectiveCwd);

  const fullPrompt = buildWorkerPrompt({
    task,
    mode,
    isGit: gitRepo,
    cwd: effectiveCwd,
    constraints: params.constraints,
  });
  fs.writeFileSync(promptFile, fullPrompt, 'utf8');

  const args =
    worker === 'codex'
      ? buildCodexArgs({
          cwd: effectiveCwd,
          mode,
          isGit: gitRepo,
          model,
          sessionId: parentMeta.sessionId,
          lastMessageFile,
        })
      : buildDshArgs({
          argsPrefix: backend.argsPrefix,
          useStoredCredentials,
          authPatchPath,
          sessionId: parentMeta.sessionId,
        });

  const proc = await runProcess({
    command: backend.command,
    args,
    cwd: effectiveCwd,
    stdinText: fullPrompt,
    timeoutMs: timeoutSec * 1000,
    stdoutFile,
    stderrFile,
  });

  const lastMessageContent = fs.existsSync(lastMessageFile)
    ? fs.readFileSync(lastMessageFile, 'utf8')
    : '';
  const parsed =
    worker === 'codex'
      ? parseCodexJsonl(proc.stdout, lastMessageContent)
      : parseDshJsonl(proc.stdout);

  if (worker === 'dsh' && parsed.finalMessage && !fs.existsSync(lastMessageFile)) {
    fs.writeFileSync(lastMessageFile, parsed.finalMessage, 'utf8');
  }

  let changedFiles = [];
  let diffStat = '';
  let diffFile = null;

  if (gitRepo) {
    const gitChanges = computeGitChanges(effectiveCwd, gitBaseline);
    changedFiles = gitChanges.changedFiles;
    diffStat = gitChanges.diffStat;
    if (gitChanges.diffPatch) {
      diffFile = path.join(runDir, 'diff.patch');
      fs.writeFileSync(diffFile, gitChanges.diffPatch, 'utf8');
    }
  } else if (beforeSnapshot) {
    const afterSnapshot = captureFsSnapshot(effectiveCwd);
    const snapDiff = diffFsSnapshots(beforeSnapshot, afterSnapshot);
    changedFiles = snapDiff.changedFiles;
    diffStat = `+${snapDiff.added.length} ~${snapDiff.modified.length} -${snapDiff.deleted.length}`;
    diffFile = path.join(runDir, 'snapshot-diff.json');
    fs.writeFileSync(diffFile, JSON.stringify(snapDiff, null, 2) + '\n', 'utf8');
  }

  const status = determineStatus({
    timedOut: proc.timedOut,
    exitCode: proc.exitCode,
    errors: parsed.errors,
    turnEndReason: parsed.turnEndReason,
  });

  const result = {
    runId,
    parentRunId: params.runId,
    worker,
    status,
    sessionId: parsed.sessionId || parentMeta.sessionId,
    mode,
    isGit: gitRepo,
    cwd: parentMeta.cwd,
    effectiveCwd,
    worktreeBranch: parentMeta.worktreeBranch || null,
    worktreePath: parentMeta.worktreePath || null,
    useStoredCredentials: worker === 'dsh' ? useStoredCredentials : null,
    exitCode: proc.exitCode,
    timedOut: proc.timedOut,
    durationMs: proc.durationMs,
    toolCalls: parsed.toolCalls,
    usage: parsed.usage,
    turnEndReason: parsed.turnEndReason || null,
    errors: parsed.errors,
    warnings,
    summary: parsed.finalMessage,
    changedFiles,
    diffStat,
    artifacts: {
      runDir,
      promptFile,
      stdoutFile,
      stderrFile,
      lastMessageFile: fs.existsSync(lastMessageFile) ? lastMessageFile : null,
      diffFile,
    },
    createdAt: new Date().toISOString(),
  };

  saveRunMeta(runDir, result);
  return result;
}

/**
 * Remove a managed worktree created by a previous run.
 * @param {string} runId
 * @param {boolean} forceBranch
 */
export function cleanupRunWorktree(runId, forceBranch = false) {
  const stateDir = getStateDir();
  const meta = loadRunMeta(stateDir, runId);
  if (!meta.worktreePath) {
    return { removed: false, message: `Run ${runId} did not use a managed worktree.` };
  }
  return removeWorktree(meta.cwd, meta.worktreePath, meta.worktreeBranch, {
    stateDir,
    forceBranch,
  });
}
