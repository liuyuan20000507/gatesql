# Text-to-SQL 数据分析网站

用自然语言提问，自动生成 SQL 并返回表格、图表和结论。

> 开发中。当前进度见 [docs/04-roadmap.md](docs/04-roadmap.md)。

## 这个项目解决什么问题

业务人员想看数据但不会写 SQL，只能排队等数据分析师。这个项目把「问一句话」到「拿到答案」之间的人力环节自动化：

```
用户: 上个月销售额最高的 5 个商品是什么？
  ↓
系统: [展示生成的 SQL] → [表格] → [柱状图] → 「上个月销售额最高的是无线耳机，
      达到 12.9 万元，前五名合计占总销售额的 34%……」
```

## 技术栈

- **前端** Next.js 15 + TypeScript + Tailwind + shadcn/ui + ECharts
- **后端** FastAPI + Pydantic + SQLAlchemy
- **数据库** SQLite（示例数据）
- **模型** OpenAI 兼容接口（火山方舟 / DeepSeek）
- **部署** Docker Compose

## 本地启动

**1. 准备数据库**

```bash
python scripts/seed_db.py
```

**2. 启动后端**

```bash
cd backend
pip install -r requirements.txt
copy .env.example .env
# 编辑 .env 填入你的模型 API key
uvicorn main:app --reload --port 8000
```

**3. 启动前端**

```bash
cd frontend
pnpm install
pnpm dev
```

打开 http://localhost:3000

## 项目文档

| 文档 | 内容 |
|---|---|
| [需求文档](docs/01-requirements.md) | 做什么、验收标准、评测方式 |
| [技术方案](docs/02-architecture.md) | 架构、选型理由、agent 循环设计、安全边界 |
| [接口约定](docs/03-api-contract.md) | 前后端契约，SSE 事件格式 |
| [开发路线图](docs/04-roadmap.md) | 分周任务和完成标准 |

## 核心设计

**Agent 循环**：取表结构 → 生成 SQL → 安全检查 → 执行 → 失败则带错误信息重试（上限 3 次）→ 总结成文字和图表建议

**安全防护**（五层，防止 agent 破坏数据库）：

1. 数据库以只读模式连接
2. 只允许 SELECT / WITH 开头的语句
3. 危险关键字黑名单
4. 禁止多语句执行
5. 查询超时和返回行数上限

## 评测结果

第 4 周补充。
