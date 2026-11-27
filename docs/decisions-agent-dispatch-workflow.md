# 决策记录：Agent 派发工作流（agent-dispatch）

- **日期**：2026-11-27
- **项目路径**：`<project-root>`（默认安装于 Antigravity scratch `agent-dispatch` 目录）
- **全局 Skill 路径**：`~/.gemini/config/skills/agent-dispatch/SKILL.md`
- **运行时状态目录**：`~/.agent-dispatch/`（可通过环境变量 `AGENT_DISPATCH_HOME` 自定义）

---

## 已确定决策（D1–D11）

| # | 主题 | 结论 | 理由 |
|---|---|---|---|
| D1 | 核心动机 | 配额/成本分流 + 能力/生态互补 + 统一入口（非高并发优先） | 不为高并发过度设计；前置分析需控制主模型 token 消耗 |
| D2 | 交付形态 | Antigravity Skill + 本地薄封装 CLI 脚本（统一 JSON 协议） | 先跑通上下文交接与验收闭环，JSON 协议方便后续无缝升级 MCP/UI |
| D3 | 控制权与审批 | 小任务主模型直做；中大任务先出派发单，经用户确认后再派发 | 降低前期误解需求或分错工具的风险 |
| D4 | 路由机制 | 可编辑 `routing.json` + 默认推荐 + 派发单可随时改派/兜底 | 路由规则透明可调，额度受限时可一键切换备选工具 |
| D5 | 沙箱与隔离 | 按风险分级（`readonly` / `inplace` 基线 / 高风险或并行切 `worktree`）；硬禁 `git push`、删分支、改项目外全局配置 | 兼顾日常效率与高风险可回滚性，不可逆操作收口到验收之后 |
| D6 | 前置分析深度 | 两档动态切换（默认轻量侦察，复杂/模糊升级中度设计）+ 模板化任务书 | 平衡省主模型额度与防 worker 跑偏 |
| D7 | 验收与返工 | 主模型必须检查 diff / 快照 + 跑验证命令并如实汇报；续跑/换人/补刀由用户拍板 | 保证拿证据交差，防止自动返工死循环烧额度 |
| D8 | `dsh` 认证 | 派发脚本通过临时 `--patch` 启用 `credentials` / `authorization` / `deepseek-account`，直接复用现有登录态 | 免配独立 API Key，且不污染全局 `headless` profile |
| D9 | 超时与运行记录 | 默认超时 10 分钟（派发单可调，上限 30 分钟），超时强杀进程树并保现场；日志/diff/`session_id` 统一存 `~/.agent-dispatch/runs/` | 不污染目标项目仓库，便于续跑与排查 |
| D10 | 非 Git 边界与技术栈 | 非 Git 目录允许派发（写操作前显式预警 + 文件前后快照核对）；工具源码用零重依赖 Node.js ESM，放在 `scratch/agent-dispatch`，全局 Skill 装到 `~/.gemini/config/skills/agent-dispatch/` | 复用本机 Node 24，零外部依赖，全工作区随时可触发 |
| D11 | 默认路由初版 | 主模型直做（纯问答/设计、≤2 文件小改、派发前分析与派发后验收）；`codex`（中大型编码、重构、测试、严格沙箱改代码、Code Review）；`dsh`（通用脚本、调研文档、中文重上下文、dsh 生态任务及兜底）；默认继承各自配置模型 | 符合当前使用习惯，后续可随时修改 `~/.agent-dispatch/routing.json` |

---

## 暂未确定 / 留待实战观察项

1. 跑顺十来次后，是否对低风险任务放宽为「免确认自动派发」。
2. 后续是否需要将统一 JSON 协议再包一层 MCP Server 或本地 Web 看板。
3. 实战使用一段时间后，是否需要微调 `routing.json` 规则权重或为特定任务固定模型。
