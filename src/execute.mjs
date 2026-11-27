import fs from 'node:fs';
import path from 'node:path';
import { buildCodexArgs, parseCodexJsonl } from './adapters/codex.mjs';
import { buildDshArgs, buildDshOverridePatchYaml, parseDshJsonl, resolveDshDefaultModel } from './adapters/dsh.mjs';
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

function inferTier({ mode, task, explicitTier }) {
  if (explicitTier && ['light', 'standard', 'heavy'].includes(explicitTier)) {
    return explicitTier;
  }
  if (mode === 'worktree' || String(task || '').length > 300) return 'heavy';
  if (mode === 'readonly') return 'light';
  return 'standard';
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

  const tier = inferTier({ mode, task, explicitTier: params.tier });
  const tierConfig = config?.tiers?.[worker]?.[tier] || {};

  const maxTimeoutSec = Number(config?.defaults?.maxTimeoutSec ?? 1800);
  const defaultTimeoutSec = Number(config?.defaults?.timeoutSec ?? 600);
  const timeoutSec = Math.min(
    maxTimeoutSec,
    Math.max(10, Number(params.timeoutSec || tierConfig.timeoutSec || defaultTimeoutSec))
  );

  const model = params.model ?? tierConfig.model ?? config?.models?.[worker] ?? null;
  const effort = params.effort ?? tierConfig.effort ?? null;
  const codexThreadSource = worker === 'codex'
    ? (config?.defaults?.codexThreadSource ?? 'vscode')
    : null;

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
  let dshOverrideYaml = null;
  if (worker === 'dsh' && (model || effort)) {
    const base = params.dryRun ? { provider: 'deepseek-official', model: 'deepseek-flash' } : resolveDshDefaultModel(backend);
    dshOverrideYaml = buildDshOverridePatchYaml({
      model,
      effort,
      baseProvider: base.provider,
      baseModel: base.model,
    });
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
    const fakeOverridePath = dshOverrideYaml
      ? path.join(stateDir, 'runs', '<run-id>', 'dsh-override-patch.yml')
      : null;
    const args =
      worker === 'codex'
        ? buildCodexArgs({
            cwd,
            mode,
            isGit: gitRepo,
            model,
            effort,
            threadSource: codexThreadSource,
            sessionId: null,
            lastMessageFile: fakeLastMsg,
          })
        : buildDshArgs({
            argsPrefix: backend.argsPrefix,
            useStoredCredentials,
            authPatchPath,
            extraPatchPaths: fakeOverridePath ? [fakeOverridePath] : [],
            sessionId: null,
          });
    return {
      dryRun: true,
      worker,
      mode,
      tier,
      model,
      effort,
      threadSource: codexThreadSource,
      isGit: gitRepo,
      cwd,
      effectiveCwd: mode === 'worktree' ? path.join(stateDir, 'worktrees', '<run-id>') : cwd,
      command: backend.command,
      args,
      timeoutSec,
      useStoredCredentials: worker === 'dsh' ? useStoredCredentials : undefined,
      dshOverridePatch: dshOverrideYaml || undefined,
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

  let dshOverridePatchFile = null;
  if (dshOverrideYaml) {
    dshOverridePatchFile = path.join(runDir, 'dsh-override-patch.yml');
    fs.writeFileSync(dshOverridePatchFile, dshOverrideYaml, 'utf8');
  }

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
          effort,
          threadSource: codexThreadSource,
          sessionId: null,
          lastMessageFile,
        })
      : buildDshArgs({
          argsPrefix: backend.argsPrefix,
          useStoredCredentials,
          authPatchPath,
          extraPatchPaths: dshOverridePatchFile ? [dshOverridePatchFile] : [],
          sessionId: null,
        });

  const startedAt = new Date().toISOString();
  const artifacts = {
    runDir,
    promptFile,
    stdoutFile,
    stderrFile,
    lastMessageFile: null,
    diffFile: null,
    dshOverridePatchFile,
  };

  const liveMeta = {
    runId,
    parentRunId: null,
    worker,
    status: 'running',
    pid: null,
    sessionId: null,
    mode,
    tier,
    model,
    effort,
    threadSource: codexThreadSource,
    isGit: gitRepo,
    cwd,
    effectiveCwd,
    worktreeBranch: worktreeInfo?.branch || null,
    worktreePath: worktreeInfo?.worktreePath || null,
    useStoredCredentials: worker === 'dsh' ? useStoredCredentials : null,
    timeoutSec,
    warnings,
    artifacts,
    startedAt,
    createdAt: startedAt,
  };
  saveRunMeta(runDir, liveMeta);

  let proc;
  try {
    proc = await runProcess({
      command: backend.command,
      args,
      cwd: effectiveCwd,
      stdinText: fullPrompt,
      timeoutMs: timeoutSec * 1000,
      stdoutFile,
      stderrFile,
      onSpawn: (pid) => {
        liveMeta.pid = pid;
        saveRunMeta(runDir, liveMeta);
      },
    });
  } catch (err) {
    saveRunMeta(runDir, {
      ...liveMeta,
      status: 'error',
      exitCode: 1,
      timedOut: false,
      errors: [err?.message || String(err)],
      finishedAt: new Date().toISOString(),
    });
    throw err;
  }

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
  let preexistingDirtyFiles = [];
  let diffStat = '';
  let diffFile = null;

  if (gitRepo) {
    const gitChanges = computeGitChanges(effectiveCwd, gitBaseline);
    changedFiles = gitChanges.changedFiles;
    preexistingDirtyFiles = gitChanges.preexistingDirtyFiles || [];
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

  const finishedAt = new Date().toISOString();
  const result = {
    runId,
    parentRunId: null,
    worker,
    status,
    pid: liveMeta.pid,
    sessionId: parsed.sessionId,
    mode,
    tier,
    model,
    effort,
    threadSource: codexThreadSource,
    isGit: gitRepo,
    cwd,
    effectiveCwd,
    worktreeBranch: worktreeInfo?.branch || null,
    worktreePath: worktreeInfo?.worktreePath || null,
    useStoredCredentials: worker === 'dsh' ? useStoredCredentials : null,
    timeoutSec,
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
    preexistingDirtyFiles,
    diffStat,
    artifacts: {
      ...artifacts,
      lastMessageFile: fs.existsSync(lastMessageFile) ? lastMessageFile : null,
      diffFile,
    },
    startedAt,
    finishedAt,
    createdAt: finishedAt,
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
  const tier = params.tier || parentMeta.tier || 'standard';
  const gitRepo = Boolean(parentMeta.isGit);
  const model = params.model ?? parentMeta.model ?? config?.models?.[worker] ?? null;
  const effort = params.effort ?? parentMeta.effort ?? null;
  const codexThreadSource = worker === 'codex'
    ? (parentMeta.threadSource ?? config?.defaults?.codexThreadSource ?? 'vscode')
    : null;

  const useStoredCredentials =
    parentMeta.useStoredCredentials !== null && parentMeta.useStoredCredentials !== undefined
      ? Boolean(parentMeta.useStoredCredentials)
      : Boolean(config?.defaults?.useDshStoredCredentials ?? true);
  const authPatchPath = getDshAuthPatchPath();

  const maxTimeoutSec = Number(config?.defaults?.maxTimeoutSec ?? 1800);
  const defaultTimeoutSec = Number(config?.defaults?.timeoutSec ?? 600);
  const timeoutSec = Math.min(
    maxTimeoutSec,
    Math.max(10, Number(params.timeoutSec || parentMeta.timeoutSec || defaultTimeoutSec))
  );

  const backend = resolveBackend(worker);
  const warnings = [];
  let dshOverrideYaml = null;
  if (worker === 'dsh' && (model || effort)) {
    const base = params.dryRun ? { provider: 'deepseek-official', model: 'deepseek-flash' } : resolveDshDefaultModel(backend);
    dshOverrideYaml = buildDshOverridePatchYaml({
      model,
      effort,
      baseProvider: base.provider,
      baseModel: base.model,
    });
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
    const fakeOverridePath = dshOverrideYaml
      ? path.join(stateDir, 'runs', '<run-id>', 'dsh-override-patch.yml')
      : null;
    const args =
      worker === 'codex'
        ? buildCodexArgs({
            cwd: effectiveCwd,
            mode,
            isGit: gitRepo,
            model,
            effort,
            threadSource: codexThreadSource,
            sessionId: parentMeta.sessionId,
            lastMessageFile: fakeLastMsg,
          })
        : buildDshArgs({
            argsPrefix: backend.argsPrefix,
            useStoredCredentials,
            authPatchPath,
            extraPatchPaths: fakeOverridePath ? [fakeOverridePath] : [],
            sessionId: parentMeta.sessionId,
          });
    return {
      dryRun: true,
      resumeOf: params.runId,
      sessionId: parentMeta.sessionId,
      worker,
      mode,
      tier,
      model,
      effort,
      threadSource: codexThreadSource,
      isGit: gitRepo,
      effectiveCwd,
      command: backend.command,
      args,
      timeoutSec,
      dshOverridePatch: dshOverrideYaml || undefined,
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

  let dshOverridePatchFile = null;
  if (dshOverrideYaml) {
    dshOverridePatchFile = path.join(runDir, 'dsh-override-patch.yml');
    fs.writeFileSync(dshOverridePatchFile, dshOverrideYaml, 'utf8');
  }

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
          effort,
          threadSource: codexThreadSource,
          sessionId: parentMeta.sessionId,
          lastMessageFile,
        })
      : buildDshArgs({
          argsPrefix: backend.argsPrefix,
          useStoredCredentials,
          authPatchPath,
          extraPatchPaths: dshOverridePatchFile ? [dshOverridePatchFile] : [],
          sessionId: parentMeta.sessionId,
        });

  const startedAt = new Date().toISOString();
  const artifacts = {
    runDir,
    promptFile,
    stdoutFile,
    stderrFile,
    lastMessageFile: null,
    diffFile: null,
    dshOverridePatchFile,
  };

  const liveMeta = {
    runId,
    parentRunId: params.runId,
    worker,
    status: 'running',
    pid: null,
    sessionId: parentMeta.sessionId,
    mode,
    tier,
    model,
    effort,
    threadSource: codexThreadSource,
    isGit: gitRepo,
    cwd: parentMeta.cwd,
    effectiveCwd,
    worktreeBranch: parentMeta.worktreeBranch || null,
    worktreePath: parentMeta.worktreePath || null,
    useStoredCredentials: worker === 'dsh' ? useStoredCredentials : null,
    timeoutSec,
    warnings,
    artifacts,
    startedAt,
    createdAt: startedAt,
  };
  saveRunMeta(runDir, liveMeta);

  let proc;
  try {
    proc = await runProcess({
      command: backend.command,
      args,
      cwd: effectiveCwd,
      stdinText: fullPrompt,
      timeoutMs: timeoutSec * 1000,
      stdoutFile,
      stderrFile,
      onSpawn: (pid) => {
        liveMeta.pid = pid;
        saveRunMeta(runDir, liveMeta);
      },
    });
  } catch (err) {
    saveRunMeta(runDir, {
      ...liveMeta,
      status: 'error',
      exitCode: 1,
      timedOut: false,
      errors: [err?.message || String(err)],
      finishedAt: new Date().toISOString(),
    });
    throw err;
  }

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
  let preexistingDirtyFiles = [];
  let diffStat = '';
  let diffFile = null;

  if (gitRepo) {
    const gitChanges = computeGitChanges(effectiveCwd, gitBaseline);
    changedFiles = gitChanges.changedFiles;
    preexistingDirtyFiles = gitChanges.preexistingDirtyFiles || [];
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

  const finishedAt = new Date().toISOString();
  const result = {
    runId,
    parentRunId: params.runId,
    worker,
    status,
    pid: liveMeta.pid,
    sessionId: parsed.sessionId || parentMeta.sessionId,
    mode,
    tier,
    model,
    effort,
    threadSource: codexThreadSource,
    isGit: gitRepo,
    cwd: parentMeta.cwd,
    effectiveCwd,
    worktreeBranch: parentMeta.worktreeBranch || null,
    worktreePath: parentMeta.worktreePath || null,
    useStoredCredentials: worker === 'dsh' ? useStoredCredentials : null,
    timeoutSec,
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
    preexistingDirtyFiles,
    diffStat,
    artifacts: {
      ...artifacts,
      lastMessageFile: fs.existsSync(lastMessageFile) ? lastMessageFile : null,
      diffFile,
    },
    startedAt,
    finishedAt,
    createdAt: finishedAt,
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
