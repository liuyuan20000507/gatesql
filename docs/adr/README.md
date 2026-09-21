# ADR 索引

> 每篇格式：背景 → 决策 → 关键问题 → 代价（→ 触发重估/对冲）。
> 「关键问题」一节是每篇的灵魂——它回答「这个决策到底在解决什么」。
> 汇总版见 [09-decisions.md](../09-decisions.md)。

| ADR | 决策 | 一句话 |
|---|---|---|
| [001](001-nextjs-fullstack-monolith.md) | Next.js 全栈单体 | SSE 契约在同一个 TS 仓库里是编译期检查 |
| [002](002-node-sqlite.md) | node:sqlite | setAuthorizer 是安全叙事核心，better-sqlite3 没有 |
| [003](003-timeout-prevent-and-abandon.md) | 超时=预防+放弃等待 | terminate() 被实测证伪，永不 resolve |
| [004](004-no-postgresql.md) | 不迁 PostgreSQL | setAuthorizer 比只读角色更细，还能挡 CTE 藏写 |
| [005](005-no-orm.md) | 不用 ORM | 被分析库结构运行时才知道，ORM 类型无意义 |
| [006](006-route-handler-vs-actions.md) | 流式/CRUD 分治 | Actions 不支持流式；Actions 自带 CSRF |
| [007](007-zod-sse-contract.md) | Zod discriminated union | 协议漂移从 review 发现升级为编译失败 |
| [008](008-fail-closed-vs-fail-open.md) | 安全 fail-closed / 口径 fail-open | 失败方向的收益相反，策略必须相反 |
| [009](009-no-vector-search.md) | 不用向量检索 | 不确定性摧毁评测可归因性 |
| [010](010-docker-standalone.md) | Docker 单容器 | app.db 写不进 serverless；附三档冷启动实测 |
| [011](011-single-password-auth.md) | 单口令 JWT | 目标只有一个：别让 key 被刷穿 |
| [012](012-no-agent-framework.md) | 不用 agent 框架 | 循环本身是核心价值，代价即收益 |
| [013](013-30-question-evalset.md) | 30 题评测集 | gold SQL 工时被最严重低估；省时投优化轮 |
| [014](014-no-full-semantic-layer.md) | 不做完整语义层 | 8 条规则拿 80% 叙事，成本 1/5 |
| [015](015-no-free-multi-turn.md) | 不做自由多轮 | 有状态摧毁可复现；conversationId 已预留 |
| [016](016-ast-fingerprint-boundary.md) | 指纹语义归一边界 | 误杀比漏抓代价大；只认可证明安全的等价 |
| [017](017-receipt-translation-scope.md) | 回执只翻译枚举形态 | 硬编模糊措辞会让卡片结构性可能撒谎 |
| [018](018-trace-schema-frozen.md) | trace 表结构冻结 | 每加字段都要重跑评测才有可比数字 |
| [019](019-replay-ci-gate.md) | CI 门禁用 replay | 「红灯=改动坏了」等式要求模型是常量 |
| [020](020-deterministic-clarify-lexicon.md) | 澄清用确定性词典 | 模型判断「该不该澄清」本身不确定 |
| [021](021-early-refuse-beyond-watermark.md) | 水位外提前拒答 | 步骤 1 结束时答案已可知，0 token |
| [022](022-column-check-zero-false-positive.md) | 列名静态核对 | 零误报纪律：漏有兜底，误杀是事故 |
| [023](023-budget-degrade-replay.md) | 预算耗尽降级 replay | 有损但可用 优于 无损但 500 |
