/**
 * Wrap a task brief with hard safety guardrails and structured output expectations.
 * @param {object} options
 * @param {string} options.task
 * @param {'readonly'|'inplace'|'worktree'} options.mode
 * @param {boolean} options.isGit
 * @param {string} options.cwd
 * @param {string[]} [options.constraints]
 * @returns {string}
 */
export function buildWorkerPrompt({ task, mode, isGit, cwd, constraints = [] }) {
  const rules = [
    `Working directory: ${cwd}`,
    'Hard prohibitions: Do NOT run `git push`, do NOT delete or force-reset branches, and do NOT modify files outside this working directory or global user config files (~/.codex, ~/.dsh, ~/.gemini).',
  ];

  if (mode === 'readonly') {
    rules.push(
      'Mode: READ-ONLY inspection. Do NOT create, modify, or delete any files, and do NOT run mutating commands.'
    );
  } else if (!isGit) {
    rules.push(
      'Notice: This directory is NOT a Git repository. Be extra careful with edits and avoid destructive deletions.'
    );
  }

  for (const extra of constraints) {
    if (extra && String(extra).trim()) {
      rules.push(String(extra).trim());
    }
  }

  return [
    task.trim(),
    '',
    '---',
    '## Execution Guardrails & Reporting',
    ...rules.map((r) => `- ${r}`),
    '- When finished, provide a concise final summary listing: (1) files changed (if any), (2) commands/checks run and their outcomes, and (3) any remaining blockers or risks.',
  ].join('\n');
}
