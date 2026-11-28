# 添加自定义 Agent 适配器（Adding a Custom Adapter）

`agent-dispatch` 通过 `src/adapters/index.mjs` 管理所有外部 CLI 执行器。只需实现一个约 40–60 行的适配器模块，即可复用现有的路由推荐、Git/非 Git 隔离、超时强杀、实时进度看板和 `resume` 能力。

## 1. 适配器接口约定

在 `src/adapters/<your-agent>.mjs` 导出一个适配器对象：

```js
import { parseJsonLines, resolveNodeCliBinary, runQuickCommand, truncateText } from './utils.mjs';

export const myAgentAdapter = {
  id: 'myagent',
  displayName: 'My Agent CLI',

  // 可选：是否像 codex 一样额外使用 -o lastMessageFile
  usesLastMessageFile: false,

  // 1. 定位可执行文件（返回 { found, command, argsPrefix, source, error? }）
  resolveBinary() {
    return resolveNodeCliBinary({
      envVar: 'MYAGENT_BIN',
      commandName: 'myagent',
    });
  },

  // 2. 获取版本字符串（用于 doctor 体检）
  getVersion(resolved) {
    if (!resolved?.found || !resolved?.command) return null;
    const res = runQuickCommand(resolved.command, [...(resolved.argsPrefix || []), '--version']);
    return res.ok ? res.stdout : null;
  },

  // 3. 构造非交互运行参数（提示词会通过 UTF-8 stdin 传入）
  buildArgs({ argsPrefix = [], mode, model, sessionId }) {
    const args = [...argsPrefix, '--json'];
    if (mode === 'readonly') args.push('--read-only');
    if (model) args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);
    return args;
  },

  // 4. 解析完整 stdout，返回 { sessionId, usage, toolCalls, errors, finalMessage }
  parseResult(rawStdout) {
    let sessionId = null;
    let finalMessage = '';
    for (const ev of parseJsonLines(rawStdout)) {
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'final') finalMessage = ev.text || '';
    }
    return { sessionId, usage: null, toolCalls: 0, errors: [], finalMessage };
  },

  // 5. 解析单条 JSONL 事件用于实时看板与 watch（可返回 null 跳过）
  parseEventLine(ev, state) {
    if (ev.session_id) state.sessionId = ev.session_id;
    if (ev.type === 'tool_call') {
      state.toolCalls += 1;
      return { kind: 'tool_call', title: ev.name || 'tool', detail: truncateText(ev.input || '') };
    }
    return null;
  },
};
```

## 2. 注册并启用

1. 在 `src/adapters/index.mjs` 中引入并注册 `myAgentAdapter`。
2. 在 `config/routing.json`（或 `~/.agent-dispatch/routing.json`）的 `defaults.enabledWorkers` 中加入 `"myagent"`，并在 `workers.myagent` 添加关键词规则。
3. 运行 `node bin/dispatch.mjs doctor` 和 `node bin/dispatch.mjs run --worker myagent --dry-run --task "test"` 验证识别与参数拼接。
