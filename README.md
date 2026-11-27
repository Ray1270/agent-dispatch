# agent-dispatch

面向 **Antigravity + Codex CLI + DeepSeek Harness (`dsh`)** 的本地任务分析、分流路由、沙箱隔离与实证验收工作流（零外部依赖，Node.js ESM）。

## 功能特点

- **智能路由推荐（`route`）**：依据任务类型、风险和改动规模，在主模型直做、`codex`、`dsh` 之间推荐分工，并支持用户配置覆盖。
- **双引擎非交互适配**：
  - **Codex CLI**：自动发现本机 `CODEX_BIN`、`PATH` 或 Windows Store `OpenAI.Codex` 应用包内的 `codex.exe`，统一使用 `exec --json` / `exec resume` 与 `-o` 捕获最终消息。
  - **DeepSeek Harness (`dsh`)**：调用 `dsh --profile headless --json`，默认通过 `--patch` 自动接通本机已有登录凭据，无需额外配置 API Key。
- **分级隔离与安全护栏**：
  - `readonly`：只读调研与审查
  - `inplace`：就地改动，自动记录 Git 基线或非 Git 目录文件快照
  - `worktree`：高风险或并行改动，在状态目录下创建临时 Git worktree 隔离执行
  - 内置硬性禁令（禁止 `git push`、删分支/强推、修改项目外全局配置）
- **超时保护与运行归档**：默认 10 分钟超时（可调至 30 分钟），超时自动强杀进程树并保留现场；日志、diff 与 `sessionId` 统一保存在状态目录，不污染目标仓库。

## 环境要求

- Node.js `>= 22.0.0`
- Git
- Codex CLI（已在 PATH 中，或已安装 Windows Store 版 `OpenAI.Codex`）
- DeepSeek Harness（`@deepseek-ai/dsh`）

## 快速开始

```bash
# 1. 检查运行环境与登录态
node bin/dispatch.mjs doctor

# 2. 运行单元与集成测试
npm test

# 3. 获取任务路由建议
node bin/dispatch.mjs route --cwd "/path/to/repo" --task "重构登录模块并补充测试"

# 4. 派发任务（支持 --dry-run 预览命令，可按需覆盖 --model 与 --effort）
node bin/dispatch.mjs run --worker codex --mode readonly --effort medium --cwd "/path/to/repo" --task "检查项目结构"

# 5. 打开实时进度网页看板 / 终端实时跟踪
node bin/dispatch.mjs ui
node bin/dispatch.mjs watch

# 6. 基于 runId 续派同一会话
node bin/dispatch.mjs resume --run-id "<run-id>" --task "继续修复剩余报错"

# 7. 查看最近运行记录 / 检查单次详情 / 清理 worktree
node bin/dispatch.mjs list --limit 10
node bin/dispatch.mjs inspect --run-id "<run-id>"
node bin/dispatch.mjs cleanup-worktree --run-id "<run-id>"
```

## 模型、思考强度与实时看板

- **默认继承 + 分档调节**：`routing.json` 中 `models.codex` / `models.dsh` 默认为 `null`（继承本机各自默认配置）；`tiers` 支持按 `light`（只读）、`standard`（常规）、`heavy`（高风险/worktree/大任务）自动选择思考强度与超时（例如 Codex 默认 `medium` / `high` / `ultra`，heavy 自动 1200s）。
- **单次覆盖**：通过 `--model <id>` 与 `--effort <level>` 可覆盖任意一次 `run` 或 `resume`：
  - `codex` 通过 `-m` 与 `-c model_reasoning_effort=...` 传递，并默认附带 `--thread-source vscode` 便于在桌面端查看会话；
  - `dsh` 通过单次临时 `--patch` 覆写 `agent-default-model` 的 `model` / `reasoningEffort`，不影响全局配置。
- **实时看板（侧边栏 / 独立网页 / 终端）**：
  - **Antigravity 侧边栏直开（推荐）**：安装完整 `plugin/`（含 `sidecars/dashboard/`）后，可在侧边栏直接打开 **Dispatch 看板**，无需另开浏览器窗口。
  - **独立网页 / 终端**：也可运行 `npm run ui`（默认 `http://127.0.0.1:4310`）或 `node bin/dispatch.mjs watch` 查看实时步骤流、耗时进度条、工具调用与变更清单。

## 配置与状态目录

- 运行时状态、历史记录（`runs/`）、临时工作树（`worktrees/`）以及可编辑的 `routing.json` 默认保存在 `~/.agent-dispatch/`。
- 如需迁移出默认目录（例如挪到其他磁盘），设置环境变量 `AGENT_DISPATCH_HOME` 指向目标目录即可。

## 安装 Antigravity 插件（推荐，支持主动触发与侧边栏看板）

将 [`plugin/`](plugin/) 目录整体复制到 `~/.gemini/config/plugins/agent-dispatch/`，并将 `skills/agent-dispatch/SKILL.md` 及 `sidecars/dashboard/main.mjs` 中的 `<AGENT_DISPATCH_ROOT>` 替换为本仓库的实际本地路径。

安装后包含：
- `rules/AGENTS.md`：常驻轻量规则，让主模型遇到中大型编码、重构、测试、脚本或调研任务时**主动进入派发分析并给出确认单**（无需每次手动提醒）。
- `skills/agent-dispatch/SKILL.md`：完整的分析、派发、验收与返工流程。
- `sidecars/dashboard/`：内嵌于 Antigravity 右侧边栏的实时进度看板。
- 在 Antigravity 插件设置中可随时一键开启/关闭。

如果不需要自动触发规则、只想手动按需调用，也可以只把 [`skill/SKILL.md`](skill/SKILL.md) 复制到 `~/.gemini/config/skills/agent-dispatch/SKILL.md`（同样替换 `<AGENT_DISPATCH_ROOT>`）。
