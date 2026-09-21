# ADR-001 · 用 Next.js 全栈单体，不拆前后端

**背景**：原计划 Next.js 前端 + FastAPI 后端。

**决策**：单一 Next.js 16 应用（App Router），前后端同仓同进程。

**关键问题**：SSE 事件协议需要前端 / Route Handler / 评测脚本三方共享。同一个 TypeScript 仓库里是编译期契约检查；跨语言就只能靠文档和自觉。

**代价**：放弃 Python 数据生态；`node:sqlite` 生态资料少；长流式与 serverless 部署冲突（因此选自托管容器，见 ADR-010）。

**何时重估**：需要 Python 专属能力（重 ML）且愿意付双栈成本时。
