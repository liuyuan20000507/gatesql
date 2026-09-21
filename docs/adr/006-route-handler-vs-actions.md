# ADR-006 · 流式走 Route Handler，CRUD 走 Server Actions

**背景**：App Router 有两种服务端能力，边界必须明确。

**决策**：长时流式问答 = Route Handler + `ReadableStream`（手写 SSE）；报表/纠正样本增删改 = Server Actions。

**关键问题**：Server Actions 不支持流式增量返回——agent 的多步过程必须实时推给用户；反过来，短事务 CRUD 用 Actions 免费获得 CSRF 防护和 revalidate，写 REST 是多余。

**代价**：项目里存在两种服务端范式，新人要理解边界——但这条边界判断本身就是面试内容。
