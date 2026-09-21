# ADR-007 · SSE 事件协议用 Zod discriminated union 作唯一契约

**背景**：前端、Route Handler、评测脚本三方消费同一份事件流。

**决策**：类型定义在 `src/lib/events.ts` 三方共享；前端 switch 加 `satisfies never` 穷尽检查。

**关键问题**：**把协议漂移从「靠 code review 发现」升级为「编译失败」**。运行时还有 Zod 校验兜底（模型输出/环境变量同套路）。

**代价**：Zod 运行时校验有轻微开销；事件类型增多时 union 变长。
