# ADR-005 · 不引入 ORM

**背景**：Next.js 项目通常配 Prisma / Drizzle。

**决策**：不用 ORM。`app.db` 用 `prepare` + 手写 SQL，收敛到 `src/lib/db/app.ts` 一个文件。

**关键问题**：`shop.db` 是**被分析库**——结构运行时才知道（agent 要对任意问题生成 SQL），ORM 的编译期类型在这里没有意义；`app.db` 只有几张表、访问模式固定，ORM 是纯负担。

**代价**：失去查询构造器的类型安全。对冲：每张表有手写 TS 类型 + 所有查询单文件收敛。
