# 接口约定

**这份文档是前后端之间唯一的契约。** 但它不是手工维护的 —— 真正的契约是 `src/lib/events.ts` 里的 Zod schema，本文档由它生成/对照。改接口必须先改那个文件。

## 一、为什么用 Zod discriminated union

事件协议放在一个共享模块里，被三方 import 同一份：Route Handler（生产者）、前端（消费者）、评测脚本（回放消费者）。

前端的 switch 上加 `satisfies never` 做穷尽检查：

```ts
function handle(e: CaliberEvent) {
  switch (e.type) {
    case 'run_started': /* ... */ break
    // ... 其余分支
    default: {
      const _exhaustive: never = e   // 少处理一种事件 → 编译失败
      throw new Error(`未处理的事件类型: ${JSON.stringify(_exhaustive)}`)
    }
  }
}
```

**协议漂移从「靠 code review 发现」升级为「编译失败」。** 这是选 discriminated union 而不是手写 interface 的全部理由。

## 二、`POST /api/chat` —— 核心接口

```
POST /api/chat
Content-Type: application/json
```

### 请求体

```ts
const ChatRequest = z.object({
  question: z.string().min(1).max(500),
  conversationId: z.string().nullable(),
  asOfDate: z.string().date().optional(),   // 覆盖默认时钟，评测用
})
```

### 响应：手写 SSE 流

Route Handler 返回 `ReadableStream`，不用 `EventSource` 消费 —— 它只能 GET 且不能带自定义头。前端用 `fetch` + `ReadableStream` 手动解析。

响应头必须带：

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no          ← 否则反向代理会缓冲，流式失效
```

Route Handler 里必须显式声明：

```ts
export const runtime = 'nodejs'        // node:sqlite 和 worker_threads 需要
export const dynamic = 'force-dynamic' // 禁止静态优化
```

## 三、事件类型清单

每个事件一行 `event:` + 一行 `data:`（JSON）。

### `run_started`

```ts
{ type: 'run_started', runId: string, asOfDate: string }
```
必须在 **800ms 内**送达，用户不能面对空白等待。

### `time_resolved`

```ts
{ type: 'time_resolved',
  expression: string,      // 用户原话里的时间表达，如 "近30天"
  from: string, to: string, // 解析出的绝对区间（闭开）
  display: string }        // "已理解为 2026-08-02 ~ 2026-08-31"
```
解析不出时间表达时**不发**此事件，不报错。

### `context_built`

```ts
{ type: 'context_built',
  tables: string[],        // 本次选中的表名
  fewshotIds: string[] }   // 命中的纠正样本 id
```
只推表名和 id，**不推 schema 全文**（全文进 `steps` 表，供事后复现）。

### `sql_generated`

```ts
{ type: 'sql_generated', attempt: number, sql: string, citedRules: string[] }
```
`attempt` 从 1 开始。重试时再推一次，前端**并列保留、不覆盖**，展示为「第 2 次尝试」并支持与上一次做 diff。

### `lint_result`

```ts
{ type: 'lint_result', attempt: number,
  violations: Array<{
    ruleId: string,              // 'R1' ~ 'R8'
    level: 'block' | 'warn',
    missingPredicate: string,    // "orders.status = '已完成'"
    suggestion: string,          // 中文修复建议
  }> }
```

### `rows`

```ts
{ type: 'rows',
  columns: string[],
  rows: Array<Array<string | number | boolean | null>>,
  rowCount: number,        // 实际总行数
  truncated: boolean,      // 是否超 1000 行被截断
  elapsedMs: number }
```

### `verification`

```ts
{ type: 'verification',
  checks: Array<{
    kind: 'empty_result' | 'suspicious_shape' | 'data_watermark' | 'magnitude',
    passed: boolean,
    detail: string }>,
  emptyReason?: {          // 空结果归因探针的输出
    suspectCondition: string,      // "region = '华东'"
    countIfRelaxed: number },
  incompletePeriod?: {     // 不完整周期检测
    lastPointLabel: string,        // "2026-09"
    watermark: string } }          // "2026-08-31"
```

### `receipt` —— 口径回执卡片

```ts
{ type: 'receipt',
  scope: string,           // "2026-01-01 至 2026-06-30"
  filters: string[],       // ["订单状态=已完成，已排除已取消 1873 单、已退款 2017 单"]
  method: string,          // "明细行按含折扣成交价小计求和"
  dataUntil: string,       // "2026-08-31"
  coverage: string,        // "参与计算 4203 单、7891 明细行"
  fullyTranslated: boolean } // false 时答案必须落「未核验」
```

**这个事件的载荷完全由代码从 AST + 规则表生成，模型碰不到它。** 这是它可信的全部理由。

### `state` —— 三态判定

```ts
{ type: 'state',
  verdict: 'verified' | 'unverified' | 'refused',
  reasons: string[],       // unverified/refused 时必须非空
  clarifications?: Array<{ label: string, description: string }> }  // refused 时给澄清选项
```

### `chart`

```ts
const ChartSpec = z.object({
  kind: z.enum(['bar', 'line', 'pie', 'none']),
  x: z.string(),
  y: z.array(z.string()),
  series: z.string().optional(),
  title: z.string(),
})
{ type: 'chart', spec: ChartSpec }
```
模型只输出这个**极小的 spec**，前端做确定性的 spec → ECharts option 编译。spec 引用了不存在的列或类型不匹配时降级为纯表格。

> 绝不让模型直出 ECharts option JSON：字段空间无限大、校验不可能完备、token 爆炸、一个笔误就是运行时白屏。

### `text_delta`

```ts
{ type: 'text_delta', delta: string }
```
前端拼接实现打字机效果。**结论文字里禁止出现任何数字断言** —— 数字全部来自表格和回执，模型只做定性解读。

### `error`

```ts
{ type: 'error', code: ErrorCode, message: string, detail?: string }
```

| code | 触发条件 | 前端表现 |
|---|---|---|
| `UNSAFE_SQL` | guard 拦下危险语句 | 红色警告，展示被拦语句和触发规则 |
| `COST_REJECTED` | EQP 预检判定缺失连接条件 | 展示人类可读理由，建议补充筛选条件 |
| `SQL_FAILED` | 重试预算耗尽仍失败 | 展示所有尝试与各自报错 |
| `NO_RELEVANT_TABLE` | 问题涉及的实体不存在 | 列出可查的 4 张表 + 3 个示例问题 |
| `TIMEOUT` | 执行超过 5 秒 | 提示缩小查询范围 |
| `BUDGET_EXCEEDED` | 超出单 run 或日预算 | 说明降级原因并给出已有中间结果 |
| `LLM_ERROR` | 模型接口异常 | 可重试按钮 |
| `SCHEMA_PARSE_FAILED` | 结构化输出解析失败且自修无效 | 走拒答态 |

### `done`

```ts
{ type: 'done',
  runId: string, elapsedMs: number,
  attempts: number, llmCalls: number,
  tokens: { input: number, output: number }, costCny: number }
```

**`done` 在任何分支下都必发**，包括 UNSAFE_SQL、TIMEOUT、BUDGET_EXCEEDED、拒答、客户端 abort。前端不存在卡在 loading 的路径。

## 四、事件顺序保证

正常路径：

```
run_started → time_resolved? → context_built → sql_generated(1) → lint_result(1)
  → rows → verification → receipt → state → chart → text_delta × N → done
```

需要重试时，在 `rows` 之前插入：

```
lint_result(1)[block] → sql_generated(2) → lint_result(2) → ...
```

出错时：任意位置推 `error`，随后立刻推 `done`。

## 五、`GET /api/schema`

前端侧边栏用它展示「你可以问这些数据」。

```ts
{
  asOfDate: string,          // "2026-08-31"
  tables: Array<{
    name: string,
    comment: string,         // 来自 _column_comments
    rowCount: number,
    dateRange?: { from: string, to: string },
    columns: Array<{
      name: string, type: string, comment: string,
      nullRate: number,
      enumValues?: string[], // 低基数列（≤20 个不同值）给全部取值
      distinctCount: number,
    }>
  }>
}
```

## 六、`GET /api/health`

```ts
{ status: 'ok' | 'degraded',
  dbConnected: boolean,
  llmMode: 'live' | 'record' | 'replay',
  dailyBudgetRemaining: number }
```

`llmMode` 为 `replay` 且非主动配置时，说明日预算已耗尽触发降级。

## 七、Server Actions（不走 HTTP 接口）

报表和纠正样本的增删改用 Server Actions，不定义 REST 接口。理由见 [架构设计](02-architecture.md#二为什么这样分层)。

```ts
saveReport(runId: string, name: string): Promise<{ id: string }>
runReport(reportId: string): Promise<QueryResult>        // 不调 LLM
deleteReport(reportId: string): Promise<void>
saveCorrection(runId: string, editedSql: string): Promise<{ id: string }>  // 入库前过 guard + EQP
```

## 八、后端没写好时前端怎么开发

第 1 周后端先做一个**桩接口**：不调模型、不查数据库，按上面的顺序把写死的事件用 300ms 间隔推出去。

这样前端能完整开发和调试，第 2 周后端接上真实逻辑时前端**一行都不用改**。如果需要改前端，说明接口约定没被遵守 —— 回来对照本文档。

这就是先定契约的意义。
