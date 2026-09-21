# ADR-002 · 用 node:sqlite，不用 better-sqlite3

**背景**：需要 Node 里跑 SQLite 且能做安全管控的驱动。

**决策**：Node 24 内置 `node:sqlite`（DatabaseSync）。

**关键问题**：安全叙事的核心是 `setAuthorizer`（引擎级授权回调，拿到解析后的表/列三元组）——**better-sqlite3 完全没有这个能力**。另外它要 node-gyp 原生编译（Windows + Docker 双雷区）。

**代价**：同步 API，慢查询会冻住事件循环（靠 worker 隔离解决，见 ADR-003）；API 新、资料少。

**何时重估**：不需要引擎级授权、且想要异步 API 时——但目前没有更好的替代。
