# 数据模型

本项目有**两个物理隔离的 SQLite 文件**。这不是为了方便，是安全设计的一部分。

| 文件 | 角色 | 连接方式 | agent 能看到吗 |
|---|---|---|---|
| `data/shop.db` | 被分析的业务库 | `{ readOnly: true }` + `setAuthorizer` 表白名单 | 能读，不能写 |
| `data/app.db` | 应用自身的库（trace / 报表 / 纠正样本） | 读写 | **完全看不到** |

agent 持有的那个连接根本不知道 `app.db` 存在，所以它不可能通过 SQL 篡改自己的运行记录、读到报表或纠正样本。这类问题是任何 SQL 层校验都覆盖不到的 —— 只能靠物理隔离。

---

## 一、`shop.db` —— 被分析的业务库

由 `scripts/seed_db.py` 生成（固定随机种子 42，保证可复现）。

```
customers ──┐
            │  customer_id
            ▼
         orders ──┐
                  │  order_id
                  ▼
            order_items ──── product_id ───► products
```

### 表结构

**`customers`**（500 行）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 客户 ID |
| `name` | TEXT | 客户姓名 |
| `region` | TEXT | 所在地区，**可能为 NULL** |
| `level` | TEXT | 会员等级：普通 / 银卡 / 金卡 / 钻石 |
| `registered_at` | TEXT | 注册日期 `YYYY-MM-DD` |

**`products`**（30 行）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 商品 ID |
| `name` | TEXT | 商品名称 |
| `category` | TEXT | 分类（5 类） |
| `price` | REAL | **标准售价 —— 不是实际成交价** |
| `cost` | REAL | 成本价 |

**`orders`**（12000 行）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 订单 ID |
| `customer_id` | INTEGER FK | → `customers.id` |
| `created_at` | TEXT | 下单日期，范围 2025-01-01 ~ 2026-08-31 |
| `status` | TEXT | **已完成 / 已取消 / 已退款** |
| `channel` | TEXT | APP / 小程序 / 网页，**可能为 NULL** |

**`order_items`**（22558 行）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 明细 ID |
| `order_id` | INTEGER FK | → `orders.id` |
| `product_id` | INTEGER FK | → `products.id` |
| `quantity` | INTEGER | 数量 |
| `unit_price` | REAL | **成交单价 —— 可能因促销低于 `products.price`** |
| `amount` | REAL | 小计 = `quantity × unit_price` |

**`_column_comments`** —— 字段中文注释表

SQLite 原生不支持列注释，所以单独建表存。`GET /api/schema` 和喂给模型的 schema 卡片都从这里取。

| 字段 | 说明 |
|---|---|
| `table_name` | 表名 |
| `column_name` | 列名，`_table` 表示这是表级注释 |
| `comment` | 中文说明 |

> `_column_comments` 和 `sqlite_master` 不允许被 SQL 查询 —— schema 信息由应用层主动组装后喂给模型。拦截在语句层完成（guardSql 的表名收集，见 [安全设计](07-security.md)）；引擎层 authorizer 按动作码挡写操作，实测不传递表名，故不做表级过滤。

### 三个刻意埋设的陷阱

这些不是数据质量问题，是产品要解决的问题本身。锚点数字已用脚本核对，任何一轮评测里它们对不上就说明比对链路坏了。

| 陷阱 | 错误写法 | 得到 | 正确答案 | 对应规则 |
|---|---|---|---|---|
| 忘记过滤订单状态 | `SUM(oi.amount)` 不加 `status` 条件 | 60,765,700.25 | **41,015,358.75** | R1 |
| JOIN 扇出 | `COUNT(o.id)` 而非 `COUNT(DISTINCT o.id)` | 客单价 2698.56 | **5057.38** | R3 |
| 用标准售价而非成交价 | `SUM(oi.quantity * p.price)` | 43,560,642.14（**仅偏 6.2%**） | 41,015,358.75 | R2 |

其他特征：`region` 和 `channel` 有 NULL 值（测试空值处理）；部分客户从未下单（测试 LEFT JOIN / NOT EXISTS）；数据止于 2026-08-31 而当前是 2026-09-11（测试数据边界和不完整周期）。

---

## 二、`app.db` —— 应用自身的库

**这套表结构必须在第 2 周一次设计对。** 后面每加一个字段都要重跑整套评测才能拿到可比的数字 —— 这是本项目最贵的返工点之一。

### `runs` —— 一次问答

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | run id |
| `question` | TEXT | 用户原文 |
| `as_of_date` | TEXT | 本次使用的时钟 |
| `verdict` | TEXT | `verified` / `unverified` / `refused` |
| `verdict_reasons` | TEXT (JSON) | 降级或拒答的具体原因 |
| `final_status` | TEXT | `ok` / 各类 error code / `aborted` |
| `attempts` | INTEGER | SQL 尝试次数 |
| `llm_calls` | INTEGER | 本次 LLM 调用数 |
| `input_tokens` / `output_tokens` | INTEGER | token 统计 |
| `cost_cny` | REAL | 成本 |
| `elapsed_ms` | INTEGER | 端到端耗时 |
| `llm_mode` | TEXT | `live` / `record` / `replay` |
| `user_feedback` | TEXT | `good` / `bad` / NULL —— 驱动纠正回流 |
| `created_at` | TEXT | |

### `steps` —— 异质的执行步骤

一次 run 挂多条 step。**难点在于它要同时容纳「LLM 调用」和「SQL 尝试」两种完全不同的记录**，所以用 `kind` + `attributes` JSON 的设计。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `run_id` | TEXT FK | |
| `seq` | INTEGER | 单调递增 |
| `kind` | TEXT | `llm_call` / `sql_attempt` / `guard` / `lint` / `eqp` / `execute` / `verify` / `receipt` |
| `started_at` / `ended_at` | INTEGER | 毫秒时间戳 |
| `status` | TEXT | `ok` / `rejected` / `failed` |
| `attributes` | TEXT (JSON) | 见下 |

`attributes` 按 `kind` 存不同内容：

- `llm_call` → **当次发出的完整 prompt 原文**、completion、model、input/output token、成本
- `sql_attempt` → SQL 原文、AST 规范化指纹、失败类型、数据库报错原文
- `lint` → 命中的规则 id 列表、各自的缺失谓词
- `eqp` → EQP 原始输出、判定结论
- `verify` → 四项体检的结果
- `receipt` → 是否钉住已完成口径（pinned）、filters / excluded 条数、fullyTranslated

> **必须存下当次实际发给模型的 schema 切片全文。** 否则事后无法复现「模型为什么会写错」—— 这是 trace 存在的首要理由。

### `events` —— SSE 事件的持久化副本

| 字段 | 类型 | 说明 |
|---|---|---|
| `run_id` | TEXT FK | 建索引 |
| `seq` | INTEGER | 单调递增 |
| `type` | TEXT | 事件类型 |
| `payload` | TEXT (JSON) | 事件载荷 |

`/runs/[id]` 详情页在服务端读这张表，用 `reduceEvents` 折叠后 RSC 渲染 —— 与客户端实时消费的**是同一个函数**。保留 30 天。

### `reports` —— 固化的报表

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | |
| `name` | TEXT | 报表名 |
| `sql` | TEXT | 存下来的那条 SQL |
| `chart_spec` | TEXT (JSON) | 图表配置 |
| `source_run_id` | TEXT | 来自哪次问答 |
| `created_at` | TEXT | |

点报表重跑时直接执行这条 SQL，**不调模型**、约 200ms、零 token、同样输入永远同样输出。

### `corrections` —— 纠正样本

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | |
| `question` | TEXT | 原问题 |
| `sql` | TEXT | 用户改对的 SQL |
| `tables` | TEXT (JSON) | 涉及的表名，用于确定性检索打分 |
| `keywords` | TEXT (JSON) | 提取的关键词 |
| `enabled` | INTEGER | 可整体开关，用于 A/B 评测 |
| `verified_by_user` | INTEGER | 入库前必须用户确认结果正确 |
| `created_at` | TEXT | |

> 入库前先过一遍 `guard` 和 EQP 预检，并要求用户确认结果正确 —— 防止脏样本反过来污染 few-shot。

### `eval_runs` / `eval_items` —— 评测记录

| 表 | 说明 |
|---|---|
| `eval_runs` | 一次评测：日期、模型名、commit hash、llm_mode、九项汇总指标 |
| `eval_items` | 每题：题号、层级、是否通过、系统三态、重试次数、耗时、token、与上轮相比是否由对转错 |

「本轮相对上轮由对转错的题号清单」就是从这两张表算出来的。

---

## 三、建模方式

不引入 ORM。理由：

- `shop.db` 是**运行时才知道结构**的被分析库，ORM 的编译期类型在这里没有意义，而且 agent 必须走原始 SQL 字符串
- `app.db` 只有 6 张表、访问模式固定，`node:sqlite` 的 `prepare` + 手写 SQL 足够，还省掉一层迁移工具的依赖和 Docker 体积

代价是失去了类型安全的查询构造器。对冲办法：`app.db` 的每张表在 `src/types/db.ts` 里有对应的 TypeScript 类型，所有查询函数收敛到 `src/lib/db/app.ts` 一个文件里，其他地方不允许直接写 SQL。

这条决策要写进 [ADR](09-decisions.md)，因为它是面试时「你为什么不用 Prisma/Drizzle」的标准问题。

## 四、迁移

`app.db` 的建表语句放在 `src/lib/db/schema.sql`，应用启动时执行 `CREATE TABLE IF NOT EXISTS`。不引入迁移框架 —— 单人项目、表结构第 2 周一次定死，加一个迁移工具是纯负担。

如果确实需要改结构：改 `schema.sql`、删掉本地 `app.db`、重跑。评测数据在 `fixtures/` 里，不会丢。
