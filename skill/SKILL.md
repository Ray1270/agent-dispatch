---
name: agent-dispatch
description: 由主模型分析任务、出派发单确认后，分流派发给 Codex CLI 或 DeepSeek Harness (dsh) 非交互执行，并在完成后实证验收。当用户要求"派发给 codex / dsh"、"用工作流分工执行"、"省额度让 codex/dsh 干活"，或遇到中大型编码实现、跨文件重构、测试编写、Code Review、自动化脚本、调研总结/文档任务时主动触发使用。
---

# Agent Dispatch 工作流（Antigravity + Codex + DSH）

> 安装提示：将本文件复制到 `~/.gemini/config/skills/agent-dispatch/SKILL.md` 时，请将文中的 `<AGENT_DISPATCH_ROOT>` 替换为本项目在本地的实际路径。

本工作流由 `<AGENT_DISPATCH_ROOT>/bin/dispatch.mjs` 提供底层执行与归档能力，运行状态与用户路由配置保存在 `~/.agent-dispatch/`（可通过 `AGENT_DISPATCH_HOME` 自定义），不污染目标仓库。

## 1. 分级判断与前置分析（省额度 + 防跑偏）

收到任务后，先判断执行归属：
- **主模型直做（不走外部派发）**：纯问答、方案/架构讨论、或者明确只需修改 `≤ 2` 个文件的小修小改。
- **需要外部派发**：中大型编码实现、跨文件重构、测试编写、Code Review、批量脚本/自动化、调研总结/文档、或用户明确要求分流给 `codex` / `dsh`。

准备派发时，动态选择分析深度：
- **默认轻量侦察**：只看目录结构、关键入口或报错信息，避免提前通读整个仓库把主模型额度烧完。
- **升级中度设计**：仅当需求模糊、跨多模块或涉及核心接口变更时，读透相关核心代码并定好接口边界再写任务书。

> 若需求本身关键前提不明确，先用简短问题向用户澄清（或先 grill 关键分歧），不要带着模糊假设派发。

## 2. 路由推荐与环境检查

在需要确认环境或计算路由推荐时，调用：

```powershell
node "<AGENT_DISPATCH_ROOT>/bin/dispatch.mjs" route --cwd "<目标目录>" --task "<任务摘要>"
```

默认分工（用户可在 `~/.agent-dispatch/routing.json` 随时调整）：
- **优先 `codex`**：中大型编码实现、跨文件重构、测试编写、严格沙箱改代码、Code Review。
- **优先 `dsh`**：通用脚本/自动化、调研总结/文档、中文重上下文任务、需利用 `dsh` 生态的任务，以及 `codex` 限额/失败时的备选兜底。
- **隔离级别**：
  - `readonly`：只读调研、排查、Code Review
  - `inplace`：常规改代码（自动记录 Git 基线或非 Git 文件快照）
  - `worktree`：大重构、高风险实验、多任务并行（仅 Git 仓库可用；创建于 `~/.agent-dispatch/worktrees/`）
- **非 Git 目录警告**：非 Git 目录允许派发写任务，但必须向用户明确预警「无 Git 自动回滚，将用前后文件快照核对变更」。

## 3. 派发前必须给用户确认「派发单」

在真正调用 `run` 之前，先向用户展示一页简明派发单并等待确认（用户可随时回复「改用 dsh / 改用 codex / 改 worktree / 超时调成 20 分钟」）：

```markdown
### 📋 派发确认单
- **任务目标**：一句话说明要做成什么
- **推荐执行者**：`codex` 或 `dsh`（附一句理由；备选兜底：`xxx`）
- **工作目录与隔离**：`<cwd>`｜`readonly` / `inplace` / `worktree`（若非 Git 且涉及写操作，标出警告）
- **超时上限**：默认 10 分钟（600s，可按需调整，上限 1800s）
- **硬性禁止**：禁止 `git push`、禁止删分支/强推、禁止修改项目外全局配置
- **验收方式**：完成后我会查看 diff/快照，并实际运行 `<具体测试/检查命令>` 验收

回复「确认」立即派发，或直接说想改哪一项。
```

## 4. 构造任务书并执行派发

用户确认后，把结构化任务书写入临时文件（例如会话 scratch 目录下的 `.md` 文件），避免命令行引号转义问题：

任务书模板：
- **目标**：清晰的结果定义
- **相关路径线索**：已知相关的文件、目录或报错位置
- **明确不做**：范围边界与禁改区域
- **验收标准**：worker 完成后应自查的命令或检查点

执行派发：

```powershell
node "<AGENT_DISPATCH_ROOT>/bin/dispatch.mjs" run --worker <codex|dsh> --mode <readonly|inplace|worktree> --cwd "<目标目录>" --timeout <秒> --task-file "<任务书路径>"
```

说明：
- `dsh` 认证：脚本默认通过 `--patch` 自动接通本机已登录的 `~/.dsh/.credentials.yaml`，无需另配 Key。
- 过程日志、diff、提示词与 `sessionId` 均持久化在 `~/.agent-dispatch/runs/<runId>/`。

## 5. 实证验收与如实汇报

`dispatch.mjs run` 返回 JSON 结果后，**绝不能只转述 worker 自己的结论**，必须亲自验收：
1. 检查返回的 `status`、`exitCode`、`timedOut`、`errors`、`changedFiles`、`diffStat`。
2. 若有代码/文件改动，阅读 `artifacts.diffFile`（`diff.patch` 或 `snapshot-diff.json`），核对是否改超范围或遗漏边界。
3. 在 `effectiveCwd`（注意：`worktree` 模式下是 `worktreePath`）实际运行验证命令（测试、构建、语法检查或只读核对）。
4. 向用户汇报：
   - 验收结论（通过 / 未通过）与实际运行命令输出
   - 改动文件清单与核心变更摘要
   - `runId`、`sessionId`、耗时与 token 用量（如有）

## 6. 失败、超时与返工（由用户拍板）

如果 worker 报错、超时（`timedOut: true`）、触发限额，或我的实证验收未通过：
- **不要自动循环重试**，以免白烧两边额度。
- 读取 `artifacts.stderrFile` / `artifacts.stdoutFile` 定位原因，向用户清楚列出问题并给出 3 个选项由用户决定：
  1. **续派原工具修**：`node "<AGENT_DISPATCH_ROOT>/bin/dispatch.mjs" resume --run-id "<runId>" --task-file "<补充说明文件>"`
  2. **换备选工具重跑**：切到 `codex` / `dsh` 重新执行
  3. **主模型直接补刀**：由我直接在当前工作区修完剩余问题

## 7. Worktree 收尾

若本次使用了 `worktree` 模式且验收通过：
1. 先询问用户是否将 `worktreeBranch`（如 `dispatch/<runId>`）的改动合回当前分支。
2. 用户确认合回并完成合并后，再执行清理：

```powershell
node "<AGENT_DISPATCH_ROOT>/bin/dispatch.mjs" cleanup-worktree --run-id "<runId>"
```
