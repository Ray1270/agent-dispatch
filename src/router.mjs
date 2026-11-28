import path from 'node:path';
import { hasAdapter, listAdapterIds } from './adapters/index.mjs';
import { isGitRepo } from './workspace.mjs';

function includesAny(textLower, keywords = []) {
  return keywords.filter((kw) => textLower.includes(String(kw).toLowerCase()));
}

function getSandboxLabel(worker, isolation) {
  if (worker === 'codex') {
    return isolation === 'readonly' ? 'read-only' : 'workspace-write';
  }
  if (worker === 'claude') {
    return isolation === 'readonly' ? 'plan' : 'acceptEdits';
  }
  if (worker === 'gemini' || worker === 'qwen') {
    return isolation === 'readonly' ? 'plan' : 'auto_edit';
  }
  return isolation === 'readonly' ? 'prompt-readonly' : 'workspace-default';
}

/**
 * Evaluate routing rules to recommend worker, fallback, isolation mode, tier, model, effort, analysis depth, and timeout.
 * @param {object} input
 * @param {string} input.task
 * @param {string} [input.cwd]
 * @param {number} [input.filesCount]
 * @param {'low'|'medium'|'high'} [input.risk]
 * @param {string} [input.forceWorker]
 * @param {'readonly'|'inplace'|'worktree'} [input.mode]
 * @param {string} [input.model]
 * @param {string} [input.effort]
 * @param {Record<string, any>} config
 */
export function recommendRoute(input, config) {
  const task = String(input.task || '').trim();
  const taskLower = task.toLowerCase();
  const cwd = input.cwd ? path.resolve(input.cwd) : process.cwd();
  const gitRepo = isGitRepo(cwd);
  const warnings = [];
  const reasons = [];

  const selfMaxFiles = Number(config?.defaults?.selfMaxFiles ?? 2);
  const defaultTimeoutSec = Number(config?.defaults?.timeoutSec ?? 600);
  const maxTimeoutSec = Number(config?.defaults?.maxTimeoutSec ?? 1800);
  const fallbackMap = config?.defaults?.defaultFallback || { codex: 'dsh', dsh: 'codex' };
  const enabledWorkers = (
    Array.isArray(config?.defaults?.enabledWorkers) && config.defaults.enabledWorkers.length
      ? config.defaults.enabledWorkers
      : ['codex', 'dsh']
  ).filter((id) => hasAdapter(id));

  const readonlyHits = includesAny(taskLower, config?.isolation?.readonlyKeywords || []);
  const worktreeHits = includesAny(taskLower, config?.isolation?.worktreeKeywords || []);
  const selfHits = includesAny(taskLower, config?.workers?.self?.keywords || []);

  const workerHits = {};
  for (const id of listAdapterIds()) {
    workerHits[id] = includesAny(taskLower, config?.workers?.[id]?.keywords || []);
  }
  const anyEnabledWorkerKeywordHit = enabledWorkers.some((id) => (workerHits[id]?.length || 0) > 0);

  // 1. Determine isolation mode
  let isolation = input.mode || null;
  if (!isolation) {
    if (input.risk === 'high' || worktreeHits.length > 0) {
      isolation = gitRepo ? 'worktree' : 'inplace';
      if (gitRepo) {
        reasons.push(`高风险/大改动（${worktreeHits.join(', ') || 'risk=high'}），建议启用 Git worktree 隔离`);
      } else {
        warnings.push('高风险改动但当前目录不是 Git 仓库，无法创建 worktree，将退回 inplace + 文件快照模式。');
      }
    } else if (
      readonlyHits.length > 0 &&
      (workerHits.codex?.length || 0) === 0 &&
      !taskLower.includes('修改') &&
      !taskLower.includes('实现') &&
      !taskLower.includes('修复')
    ) {
      isolation = 'readonly';
      reasons.push(`任务偏向只读分析/审查（${readonlyHits.join(', ')}），默认限制为只读模式`);
    } else {
      isolation = 'inplace';
      reasons.push('常规改动默认使用就地基线模式（inplace）');
    }
  } else {
    reasons.push(`采用显式指定的隔离模式：${isolation}`);
  }

  if (isolation === 'worktree' && !gitRepo) {
    warnings.push('目标目录不是 Git 仓库，worktree 模式不可用，建议改用 inplace 或先初始化 Git。');
  }
  if (!gitRepo && isolation !== 'readonly') {
    warnings.push('非 Git 目录写操作警告：无法使用 Git 自动回滚，将通过前后文件快照对比核对变更。');
  }

  // 2. Determine worker
  let worker = input.forceWorker || null;
  if (worker) {
    if (worker !== 'self' && !hasAdapter(worker)) {
      throw new Error(`Unknown worker "${worker}". Registered workers: ${listAdapterIds().join(', ')}.`);
    }
    reasons.push(`采用显式指定的执行者：${worker}`);
  } else if (
    typeof input.filesCount === 'number' &&
    input.filesCount > 0 &&
    input.filesCount <= selfMaxFiles &&
    input.risk !== 'high' &&
    !anyEnabledWorkerKeywordHit
  ) {
    worker = 'self';
    reasons.push(`预计涉及 ≤${selfMaxFiles} 个文件且风险可控，由主模型直接完成更省沟通成本`);
  } else if (selfHits.length > 0 && !anyEnabledWorkerKeywordHit && isolation === 'readonly') {
    worker = 'self';
    reasons.push(`属于纯问答/讨论/小改（命中：${selfHits.join(', ')}），无需外部派发`);
  } else {
    let bestWorker = null;
    let bestScore = 0;
    for (const id of enabledWorkers) {
      const score = workerHits[id]?.length || 0;
      if (score > bestScore) {
        bestScore = score;
        bestWorker = id;
      }
    }

    if (bestWorker && bestScore > 0) {
      worker = bestWorker;
      reasons.push(`命中 ${bestWorker} 优势关键词（${workerHits[bestWorker].join(', ')}）`);
    } else if (/[\u4e00-\u9fa5]/.test(task) && isolation === 'readonly' && enabledWorkers.includes('dsh')) {
      worker = 'dsh';
      reasons.push('中文只读调研/总结任务，默认优先分配给 dsh');
    } else {
      worker = enabledWorkers[0] || 'codex';
      const fb = fallbackMap[worker] || '';
      reasons.push(`默认开发任务优先由 ${worker} 承担${fb ? `，${fb} 作为备选兜底` : ''}`);
    }
  }

  // 3. Determine tier, model, effort, analysis depth & timeout
  const isHeavy =
    input.risk === 'high' ||
    isolation === 'worktree' ||
    (typeof input.filesCount === 'number' && input.filesCount >= 5) ||
    task.length > 300;
  const isLight = !isHeavy && isolation === 'readonly';
  const tier = isHeavy ? 'heavy' : isLight ? 'light' : 'standard';

  const tierConfig = (worker !== 'self' && config?.tiers?.[worker]?.[tier]) || {};
  const model = input.model ?? tierConfig.model ?? (worker !== 'self' ? config?.models?.[worker] : null) ?? null;
  const effort = input.effort ?? tierConfig.effort ?? null;

  const analysisDepth = isHeavy ? 'medium-design' : 'light-recon';
  const timeoutSec = Math.min(
    maxTimeoutSec,
    Number(tierConfig.timeoutSec || (isHeavy ? Math.max(defaultTimeoutSec, 1200) : defaultTimeoutSec))
  );

  let fallback = null;
  if (worker !== 'self') {
    const mapped = fallbackMap[worker];
    if (mapped && mapped !== worker) {
      fallback = mapped;
    } else {
      fallback = enabledWorkers.find((id) => id !== worker) || null;
    }
  }

  const sandbox = getSandboxLabel(worker, isolation);

  return {
    worker,
    fallback,
    isolation,
    sandbox,
    tier,
    model,
    effort,
    isGit: gitRepo,
    cwd,
    enabledWorkers,
    analysisDepth,
    timeoutSec,
    requiresConfirmation: worker !== 'self',
    reasons,
    warnings,
  };
}
