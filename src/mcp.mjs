import { listAdapterIds } from './adapters/index.mjs';
import { ensureUserConfig, getStateDir, loadConfig } from './config.mjs';
import { runDoctor } from './discovery.mjs';
import { cleanupRunWorktree, executeResume, executeRun } from './execute.mjs';
import { recommendRoute } from './router.mjs';
import { listRuns, loadRunMeta } from './store.mjs';

const WORKER_ENUM = listAdapterIds();

export const MCP_TOOLS = [
  {
    name: 'dispatch_doctor',
    description:
      'Inspect local readiness for registered CLI workers (codex, dsh, claude, gemini, qwen), git, auth files, and state storage.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch_route',
    description:
      'Analyze a task and recommend which worker (self, codex, dsh, etc.), isolation mode (readonly, inplace, worktree), tier, model, effort, and timeout to use.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task summary or brief' },
        cwd: { type: 'string', description: 'Target project directory' },
        filesCount: { type: 'number', description: 'Estimated number of files affected' },
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        forceWorker: { type: 'string', enum: ['self', ...WORKER_ENUM] },
        mode: { type: 'string', enum: ['readonly', 'inplace', 'worktree'] },
        model: { type: 'string' },
        effort: { type: 'string' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch_run',
    description:
      'Dispatch a structured task brief to an external worker CLI (codex, dsh, claude, gemini, qwen) with sandboxing/worktree isolation, timeout protection, and archived logs.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: { type: 'string', enum: WORKER_ENUM },
        task: { type: 'string', description: 'Structured task brief' },
        cwd: { type: 'string', description: 'Target project directory' },
        mode: { type: 'string', enum: ['readonly', 'inplace', 'worktree'] },
        tier: { type: 'string', enum: ['light', 'standard', 'heavy'] },
        timeoutSec: { type: 'number' },
        model: { type: 'string' },
        effort: { type: 'string' },
        constraints: { type: 'array', items: { type: 'string' } },
        useDshStoredAuth: { type: 'boolean' },
        dryRun: { type: 'boolean' },
      },
      required: ['worker', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch_resume',
    description:
      'Resume a previous dispatched run in the same session and working directory with follow-up instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        task: { type: 'string' },
        timeoutSec: { type: 'number' },
        model: { type: 'string' },
        effort: { type: 'string' },
        constraints: { type: 'array', items: { type: 'string' } },
        dryRun: { type: 'boolean' },
      },
      required: ['runId', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch_list',
    description: 'List recent archived dispatch runs.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of runs to return (default 20)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch_inspect',
    description: 'Inspect full metadata and artifact paths for a specific runId.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch_cleanup_worktree',
    description: 'Safely remove a managed Git worktree created by a worktree-mode run.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        forceBranch: { type: 'boolean' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
];

async function executeMcpTool(name, args = {}) {
  const stateDir = getStateDir();
  ensureUserConfig(stateDir);
  const config = loadConfig(stateDir);

  if (name === 'dispatch_doctor') {
    return runDoctor(config);
  }
  if (name === 'dispatch_route') {
    return recommendRoute(args, config);
  }
  if (name === 'dispatch_run') {
    return executeRun(args);
  }
  if (name === 'dispatch_resume') {
    return executeResume(args);
  }
  if (name === 'dispatch_list') {
    const runs = listRuns(stateDir, args.limit ?? 20);
    return { count: runs.length, runs };
  }
  if (name === 'dispatch_inspect') {
    return loadRunMeta(stateDir, String(args.runId || ''));
  }
  if (name === 'dispatch_cleanup_worktree') {
    return cleanupRunWorktree(String(args.runId || ''), Boolean(args.forceBranch));
  }

  throw new Error(`Unknown tool: ${name}`);
}

/**
 * Handle a single parsed MCP JSON-RPC 2.0 request or notification.
 * Returns null for notifications (messages without an `id`), or a JSON-RPC response object.
 * @param {any} msg
 */
export async function handleMcpMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    };
  }

  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
  const id = msg.id ?? null;
  const method = msg.method;

  if (!hasId) {
    // Notifications (e.g. notifications/initialized, notifications/cancelled) do not expect a response
    return null;
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'agent-dispatch',
          version: '0.2.0',
        },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: MCP_TOOLS },
    };
  }

  if (method === 'tools/call') {
    const toolName = msg.params?.name;
    const toolArgs = msg.params?.arguments || {};
    if (!toolName) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Missing tool name' },
      };
    }

    try {
      const output = await executeMcpTool(toolName, toolArgs);
      const isRunError =
        (toolName === 'dispatch_run' || toolName === 'dispatch_resume') &&
        !output?.dryRun &&
        output?.status &&
        output.status !== 'ok';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
          isError: Boolean(isRunError),
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ error: err?.message || String(err) }, null, 2) }],
          isError: true,
        },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}
