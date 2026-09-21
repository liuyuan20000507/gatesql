# ADR-004 · 不迁移到 PostgreSQL

**背景**：多份方案主张迁 PG，理由是「只读角色 + statement_timeout + pg_cancel_backend」安全叙事更硬。

**决策**：继续 SQLite。

**关键问题**：`setAuthorizer` 拿到的是解析后的 (action, 表, 列) 三元组，**比只读角色更细**，还能挡 CTE 藏写。PG 是为一个已有更好答案的问题付账。

**代价**：失去服务端异步取消；失去「企业级数据库」简历观感。

**对冲**：backlog 里写清「上 PG 会怎么做」——讲得清楚和做出来在面试里价值接近，成本差二十倍。
