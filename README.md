# agent-dispatch

零外部依赖的 **多 Agent 任务分析、路由分流、沙箱隔离执行与实证验收工作流**（Node.js ESM）。

由主 Agent 负责轻量分析、出派发确认单与事后实证验收；将编码、重构、测试、脚本、调研等重活分流给本地非交互 CLI Agent（**Codex CLI、DeepSeek Harness `dsh`、Claude Code、Gemini CLI、Qwen Code**），同时提供 **标准 MCP Server** 与 **实时进度看板**。

```text
  Host Agent (Antigravity / Claude Code / Cursor / Gemini CLI / Windsurf / MCP Client)
         │
         ▼  route / run / resume (CLI 或 stdio MCP Server)
  ┌──────────────────────────────────────────────────────────────────┐
  │                     agent-dispatch 核心层                        │
  │  路由推荐 · Git 基线/Worktree · 非 Git 快照 · 超时强杀 · 档案库   │
  └──────┬─────────────┬─────────────┬─────────────┬─────────────┬───┘
         ▼             ▼             ▼             ▼             ▼
     Codex CLI        DSH       Claude Code   Gemini CLI    Qwen Code
```

---

## 平台与执行器兼容性

### 1. 作为「指挥官 / 宿主平台」（谁来发起派发）

| 宿主平台 | 接入方式 | 实时进度查看 | 一键安装命令 |
|---|---|---|---|
| **Antigravity** | 原生 Plugin（常驻规则 + Skill + 右侧边栏 Sidecar 看板） | 原生侧边栏 **Dispatch 看板** / `ui` / `watch` | `node bin/install.mjs antigravity` |
| **Claude Code** | Skill + stdio MCP Server | `dispatch ui` 网页看板 / `watch` | `node bin/install.mjs claude-code` |
| **Cursor** | `.cursor/rules/agent-dispatch.mdc` + MCP Server | `dispatch ui` 网页看板 / `watch` | `node bin/install.mjs cursor` |
| **Gemini CLI** | Skill + stdio MCP Server | `dispatch ui` 网页看板 / `watch` | `node bin/install.mjs gemini-cli` |
| **Codex CLI** | Skill（`~/.codex/skills/`） | `dispatch ui` 网页看板 / `watch` | `node bin/install.mjs codex` |
| **Windsurf / Cline / Roo / Cherry Studio** | 标准 stdio MCP Server（`bin/mcp-server.mjs`） | `dispatch ui` 网页看板 / `watch` | `node bin/install.mjs mcp-config` |

### 2. 作为「干活执行器」（派发给谁）

| Worker ID | 工具 | 默认自动路由 | 隔离/沙箱能力 | 会话续跑 |
|---|---|---|---|---|
| `codex` | OpenAI Codex CLI（含 Windows Store Appx 自动发现） | 默认启用 | `read-only` / `workspace-write` / `worktree` | `exec resume` |
| `dsh` | DeepSeek Harness (`dsh --profile headless`) | 默认启用 | 提示词只读 / `inplace` / `worktree`，自动 `--patch` 复用本地登录态 | `--session-id` |
| `claude` | Anthropic Claude Code CLI (`claude -p`) | 按需启用或 `--worker claude` | `--permission-mode plan / acceptEdits` | `--resume` |
| `gemini` | Google Gemini CLI (`gemini -p`) | 按需启用或 `--worker gemini` | `--approval-mode plan / auto_edit` | `-r <session>` |
| `qwen` | Qwen Code CLI (`qwen --output-format stream-json`) | 按需启用或 `--worker qwen` | `--approval-mode plan / auto-edit` | `-r <session>` |

> 默认 `enabledWorkers` 为 `["codex", "dsh"]`。编辑 `~/.agent-dispatch/routing.json` 中的 `defaults.enabledWorkers` 即可随时把 `claude`、`gemini`、`qwen` 加入自动路由池，或在调用时用 `--worker <id>` 直接指定。

---

## 环境要求

- Node.js `>= 22.0.0`（零第三方 npm 依赖）
- Git
- 至少安装并登录上述任一 CLI 工具（Windows / macOS / Linux 通用）

---

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/Ray1270/agent-dispatch.git
cd agent-dispatch

# 2. 检查本机已安装的 CLI 工具、Git 与状态目录
node bin/dispatch.mjs doctor

# 3. 运行自动化测试
npm test

# 4. 一键安装到你使用的平台（如 antigravity / claude-code / cursor / gemini-cli / codex）
node bin/install.mjs antigravity
```

### 常用 CLI 命令

```bash
# 评估任务路由建议
node bin/dispatch.mjs route --cwd "/path/to/repo" --task "重构登录模块并补充测试"

# 派发任务（支持 --dry-run 预览命令，支持 --model 与 --effort 覆盖）
node bin/dispatch.mjs run --worker codex --mode readonly --effort medium --cwd "/path/to/repo" --task "检查项目结构"

# 打开实时进度网页看板（默认 http://127.0.0.1:4310）或终端实时流
node bin/dispatch.mjs ui
node bin/dispatch.mjs watch

# 基于 runId 续派同一会话
node bin/dispatch.mjs resume --run-id "<run-id>" --task "继续修复剩余报错"

# 查看历史记录 / 检查详情 / 清理 worktree
node bin/dispatch.mjs list --limit 10
node bin/dispatch.mjs inspect --run-id "<run-id>"
node bin/dispatch.mjs cleanup-worktree --run-id "<run-id>"
```

---

## 接入任意 MCP 客户端

运行 `node bin/install.mjs mcp-config` 获取适配本机路径的 JSON，加入客户端配置即可暴露 7 个标准 MCP 工具（`dispatch_doctor`、`dispatch_route`、`dispatch_run`、`dispatch_resume`、`dispatch_list`、`dispatch_inspect`、`dispatch_cleanup_worktree`）：

```json
{
  "mcpServers": {
    "agent-dispatch": {
      "command": "node",
      "args": ["/absolute/path/to/agent-dispatch/bin/mcp-server.mjs"]
    }
  }
}
```

---

## 模型分档、安全护栏与状态目录

- **模型与思考强度分档**：`routing.json` 的 `tiers` 按 `light`（只读）、`standard`（常规）、`heavy`（高风险/worktree/大任务）自动调整思考强度与超时（如 Codex 默认 `medium` / `high` / `ultra`，heavy 自动 1200s），也可随时通过 `--model` 与 `--effort` 单次覆盖。
- **硬性禁止护栏**：自动提示 worker 禁止 `git push`、删分支/强推、修改项目外全局配置；高风险或并行任务支持隔离 Git `worktree`；非 Git 目录自动做执行前后文件哈希快照对比。
- **不污染业务仓库**：所有运行日志、diff 补丁、`sessionId` 与可编辑 `routing.json` 统一保存在 `~/.agent-dispatch/`（可通过环境变量 `AGENT_DISPATCH_HOME` 迁移到任意磁盘）。

---

## 扩展更多 Agent

想接入 OpenCode、Aider 或内部自研 CLI？参考 [添加自定义 Agent 适配器指南](docs/adding-an-adapter.md)。
