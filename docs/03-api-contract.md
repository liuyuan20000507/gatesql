# 接口约定

**这份文档是前后端之间唯一的契约。** 定好之后两边可以各自开发、各自用假数据测试，不用互相等。任何改动要先改这份文档。

后端地址：`http://localhost:8000`

---

## 1. 提问（核心接口）

```
POST /api/chat
Content-Type: application/json
```

**请求体**

```json
{
  "question": "上个月销售额最高的 5 个商品",
  "conversation_id": null
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| question | string | 用户的自然语言问题，1-500 字 |
| conversation_id | string \| null | 第一次提问传 null，后端会生成并返回 |

**响应：SSE 流（`text/event-stream`）**

后端会陆续推送多个事件，前端按 `event` 类型分别处理。所有 `data` 都是一行 JSON。

### 事件类型清单

**`status`** —— 当前进行到哪一步，用来给用户看进度

```
event: status
data: {"stage": "understanding", "message": "正在理解问题"}
```

`stage` 的取值固定为这五个：`understanding` / `sql_generated` / `executing` / `retrying` / `summarizing`

**`sql`** —— 生成的 SQL 语句，前端要高亮展示

```
event: sql
data: {"sql": "SELECT p.name, SUM(oi.amount) AS revenue FROM ...", "attempt": 1}
```

`attempt` 是第几次尝试，第一次是 1。重试时会再推一次这个事件，前端应该展示为「第 2 次尝试」而不是覆盖掉原来的。

**`rows`** —— 查询结果数据

```
event: rows
data: {
  "columns": ["name", "revenue"],
  "rows": [["无线耳机", 128900.5], ["机械键盘", 98120.0]],
  "row_count": 5,
  "truncated": false
}
```

`row_count` 是实际总行数；`truncated` 为 true 表示数据被截断了（超过 1000 行），前端要提示用户。

**`chart`** —— 图表建议，前端据此渲染 ECharts

```
event: chart
data: {"type": "bar", "x": "name", "y": ["revenue"], "title": "商品销售额 TOP5"}
```

`type` 取值：`bar`（柱状）/ `line`（折线）/ `pie`（饼图）/ `none`（不适合画图，前端只显示表格）

**`text`** —— 文字结论，逐字流式推送

```
event: text
data: {"delta": "上个月销"}
```

前端要把所有 `delta` 拼接起来显示，实现打字机效果。

**`error`** —— 出错了

```
event: error
data: {"code": "SQL_FAILED", "message": "重试 3 次后仍无法生成正确的 SQL", "detail": "no such column: profit"}
```

`code` 取值：

| code | 含义 | 前端应该怎么显示 |
|---|---|---|
| `UNSAFE_SQL` | 生成了危险语句，被安全检查拦下 | 红色警告，说明只支持查询 |
| `SQL_FAILED` | 重试耗尽仍失败 | 提示换个说法再问 |
| `NO_RELEVANT_TABLE` | 数据库里没有相关数据 | 温和提示，附上可查询的表名 |
| `TIMEOUT` | 查询超时 | 提示问题涉及数据量太大 |
| `LLM_ERROR` | 大模型接口出问题 | 提示稍后重试 |

**`done`** —— 本次问答结束，前端可以解除输入框的禁用状态

```
event: done
data: {"conversation_id": "c_a1b2c3", "elapsed_ms": 4210, "attempts": 1}
```

### 事件顺序保证

正常情况：

```
status(understanding) → status(sql_generated) → sql → status(executing)
  → rows → status(summarizing) → chart → text × N → done
```

需要重试时，在 `rows` 之前会插入：

```
status(retrying) → sql(attempt=2) → status(executing) → ...
```

出错时：任意位置推 `error`，然后立刻推 `done`。**`done` 一定会推**，前端可以放心依赖它来结束加载状态。

---

## 2. 获取数据库表结构

前端用它在侧边栏展示「你可以问这些数据」，帮用户知道能问什么。

```
GET /api/schema
```

**响应**

```json
{
  "tables": [
    {
      "name": "orders",
      "comment": "订单表",
      "row_count": 12000,
      "columns": [
        {"name": "id", "type": "INTEGER", "comment": "订单号"},
        {"name": "customer_id", "type": "INTEGER", "comment": "客户ID"},
        {"name": "created_at", "type": "TEXT", "comment": "下单时间"}
      ]
    }
  ]
}
```

---

## 3. 健康检查

部署和排查时用，第 1 周就该有。

```
GET /api/health
```

**响应**

```json
{"status": "ok", "db_connected": true, "llm_configured": true}
```

---

## 前端怎么在后端还没写好时开发

第 1 周后端先做一个**假接口**：不调模型、不查数据库，就按上面的顺序把写死的事件用 `asyncio.sleep(0.3)` 间隔推出去。

这样前端能完整开发和调试，等第 2 周后端接上真实逻辑，前端一行都不用改。**这就是先定接口约定的意义。**
