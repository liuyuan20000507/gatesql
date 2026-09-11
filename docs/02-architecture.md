# 技术方案

## 整体架构

```
浏览器
  │  提问
  ▼
Next.js 前端 (localhost:3000)
  │  POST /api/chat  →  SSE 流式返回
  ▼
FastAPI 后端 (localhost:8000)
  │
  ├─ Agent 循环 ──→ 大模型 API (火山方舟 / DeepSeek)
  │      │
  │      └─ 工具: run_sql / get_schema
  │
  └─ SQLite 数据库 (data/shop.db, 只读连接)
```

## 技术选型和理由

| 层 | 选择 | 为什么选它 |
|---|---|---|
| 前端框架 | Next.js 15 + TypeScript | 招聘要求里出现频率最高；自带路由和构建，不用自己配 |
| 样式 | Tailwind CSS + shadcn/ui | 不用手写 CSS，组件直接复制到项目里，可控 |
| 图表 | ECharts | 中文文档全，图表类型多，国内公司用得多 |
| 后端框架 | FastAPI | 原生支持异步和 SSE；自动生成接口文档；Python 是 agent 生态主场 |
| 数据校验 | Pydantic v2 | 已装；用它定义所有接口的输入输出，类型错误在运行前就暴露 |
| 数据库访问 | SQLAlchemy 2.0 | 已装；用它管理只读连接和超时 |
| 数据库 | SQLite（后期可换 PostgreSQL） | 零配置，一个文件，方便别人克隆项目直接跑 |
| 大模型 | 火山方舟或 DeepSeek 的 OpenAI 兼容接口 | 便宜，国内直连不用梯子 |
| 部署 | Docker Compose | 面试官一条命令就能在自己机器上跑起来 |

## 目录结构

```
text2sql-agent/
├── CLAUDE.md               # 给 AI 看的项目约定
├── README.md               # 给人看的项目说明
├── docker-compose.yml      # 第 5 周才写
├── docs/
│   ├── 01-requirements.md  # 需求文档
│   ├── 02-architecture.md  # 本文件
│   ├── 03-api-contract.md  # 接口约定
│   ├── 04-roadmap.md       # 开发路线图
│   └── eval-log.md         # 评测记录（第 4 周开始写）
├── data/
│   ├── shop.db             # 示例数据库（运行 scripts/seed_db.py 生成）
│   └── evalset.jsonl       # 测试集（第 4 周建）
├── scripts/
│   └── seed_db.py          # 生成示例数据库
├── backend/
│   ├── requirements.txt
│   ├── main.py             # FastAPI 入口，只放路由
│   ├── config.py           # 读环境变量
│   ├── schemas.py          # Pydantic 模型（接口的输入输出）
│   ├── agent/
│   │   ├── loop.py         # ★ agent 主循环，项目核心
│   │   ├── prompts.py      # 提示词，单独放方便调
│   │   └── llm.py          # 大模型调用封装
│   └── db/
│       ├── engine.py       # 只读连接
│       ├── schema_info.py  # 提取表结构给模型看
│       └── guard.py        # ★ SQL 安全检查
└── frontend/
    ├── package.json
    └── src/
        ├── app/page.tsx        # 主页面
        ├── components/         # 对话框、SQL 展示、表格、图表
        └── lib/sse.ts          # SSE 客户端封装
```

标★的两个文件是**必须你自己动手写**的，理由见 CLAUDE.md。

## Agent 循环的设计

这是整个项目的核心，先想清楚再写代码。

```
收到问题
  │
  ├─ 1. 取数据库表结构（只取相关的表，不要把几十张表全塞给模型）
  │
  ├─ 2. 调模型：给它问题 + 表结构，要求输出 SQL
  │
  ├─ 3. 安全检查：是不是只读语句？有没有危险关键字？
  │      └─ 不通过 → 直接拒绝，不进数据库
  │
  ├─ 4. 执行 SQL（带超时，限制返回行数）
  │      ├─ 成功 → 进第 5 步
  │      └─ 报错 → 把「原 SQL + 错误信息」交给模型改，回到第 3 步
  │                 最多重试 3 次，超了就告诉用户失败
  │
  ├─ 5. 调模型：根据数据写一段结论，并选一种图表类型
  │
  └─ 6. 返回结果
```

**三个必须想清楚的问题**（面试一定会问）：

1. **怎么防死循环？** 硬性重试上限 3 次，且每次重试要带上之前所有失败记录，否则模型会反复犯同一个错。
2. **表结构怎么塞给模型？** 表少时全给；表多时先让模型判断需要哪几张表，再只给那几张的结构。这叫 schema 裁剪，是准确率提升的关键手段之一。
3. **返回多少行数据给模型总结？** 不能全给，几万行会撑爆上下文也很贵。策略是最多给前 50 行，并告诉模型总行数。

## 安全边界

Agent 能执行 SQL，等于把数据库交给了一个不完全可控的东西，必须多层防护：

1. **数据库连接层面只读** —— SQLite 用 `file:...?mode=ro` 只读模式打开，从根上写不了
2. **语句白名单** —— 只允许 `SELECT` 和 `WITH` 开头的语句
3. **关键字黑名单** —— 出现 `INSERT` `UPDATE` `DELETE` `DROP` `ALTER` `ATTACH` `PRAGMA` 一律拒绝
4. **禁止多语句** —— 检查分号，防止 `SELECT 1; DROP TABLE orders`
5. **超时和行数上限** —— 查询超过 5 秒中断，最多返回 1000 行

这五层要都做，因为任何单独一层都可能被绕过。这部分写完记得自己想办法攻击一下试试。

## 环境变量

后端根目录放 `.env`（这个文件**不要提交到 git**）：

```
LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
LLM_API_KEY=你的key
LLM_MODEL=模型名
DB_PATH=../data/shop.db
MAX_RETRY=3
MAX_ROWS=1000
QUERY_TIMEOUT=5
```
