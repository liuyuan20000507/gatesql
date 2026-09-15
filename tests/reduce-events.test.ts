import { describe, expect, it } from "vitest";

import { emptyRunState, reduceEvent, reduceEvents, type RunState } from "../src/lib/reduce-events";
import type { CaliberEvent } from "../src/lib/events";

/**
 * 一段真实的重试剧本：第 1 次 SQL 被口径规则 R1 打回（漏了 status 过滤），
 * 第 2 次通过、执行、体检、判定、出图，正常收尾。
 * 事件顺序必须与 docs/03-api-contract.md 的「事件顺序保证」一致。
 */
const happyWithRetry: CaliberEvent[] = [
  { type: "run_started", runId: "r_001", asOfDate: "2026-08-31" },
  { type: "context_built", tables: ["orders", "order_items", "products"], fewshotIds: [] },
  {
    type: "sql_generated",
    attempt: 1,
    sql: "SELECT category, SUM(amount) FROM ... -- 漏了 status 过滤",
    citedRules: ["R1"],
  },
  {
    type: "lint_result",
    attempt: 1,
    violations: [
      {
        ruleId: "R1",
        level: "block",
        missingPredicate: "orders.status = '已完成'",
        suggestion: "金额类聚合必须约束订单状态为已完成",
      },
    ],
  },
  {
    type: "sql_generated",
    attempt: 2,
    sql: "SELECT category, SUM(oi.amount) FROM ... WHERE o.status = '已完成'",
    citedRules: ["R1"],
  },
  { type: "lint_result", attempt: 2, violations: [] },
  {
    type: "rows",
    columns: ["category", "revenue"],
    rows: [
      ["手机数码", 12890050.5],
      ["电脑办公", 9812000.0],
    ],
    rowCount: 2,
    truncated: false,
    elapsedMs: 34,
  },
  {
    type: "verification",
    checks: [
      { kind: "empty_result", passed: true, detail: "结果非空" },
      { kind: "magnitude", passed: true, detail: "占总销售额 55.3%，量级正常" },
    ],
  },
  {
    type: "receipt",
    scope: "2026-01-01 至 2026-06-30",
    excluded: [
      { status: "已取消", count: 1873 },
      { status: "已退款", count: 2017 },
    ],
    filters: ["订单状态=已完成，已排除已取消 1873 单、已退款 2017 单"],
    method: "明细行按含折扣成交价小计求和",
    dataUntil: "2026-08-31",
    coverage: "参与计算 4203 单、7891 明细行",
    fullyTranslated: true,
  },
  { type: "state", verdict: "verified", reasons: [] },
  { type: "chart", spec: { kind: "bar", x: "category", y: ["revenue"], title: "分类销售额" } },
  {
    type: "done",
    runId: "r_001",
    elapsedMs: 4210,
    attempts: 2,
    llmCalls: 3,
    tokens: { input: 5100, output: 780 },
    costCny: 0.031,
  },
];

describe("reduceEvents", () => {
  it("折叠重试剧本：两次尝试并列保留，lint 结果挂在各自的 attempt 上", () => {
    const s = reduceEvents(happyWithRetry);

    expect(s.attempts).toHaveLength(2);
    expect(s.attempts[0].attempt).toBe(1);
    expect(s.attempts[0].lint).toHaveLength(1);
    expect(s.attempts[0].lint[0].ruleId).toBe("R1");
    expect(s.attempts[0].lint[0].level).toBe("block");
    // 第 2 次尝试通过了 lint，violations 为空数组而不是 undefined
    expect(s.attempts[1].lint).toHaveLength(0);
  });

  it("六项关键字段的最终值", () => {
    const s = reduceEvents(happyWithRetry);

    expect(s.runId).toBe("r_001");
    expect(s.finished).toBe(true);
    expect(s.verdict).toBe("verified");
    expect(s.result?.rowCount).toBe(2);
    expect(s.chart?.kind).toBe("bar");
    expect(s.stats?.attempts).toBe(2);
  });

  it("没有 text_delta 时结论为空串", () => {
    const s = reduceEvents(happyWithRetry);
    expect(s.summaryText).toBe("");
  });

  it("error 后收到 done：finished 为 true 且 phase 停留在 failed", () => {
    const events: CaliberEvent[] = [
      { type: "run_started", runId: "r_002", asOfDate: "2026-08-31" },
      {
        type: "error",
        code: "TIMEOUT",
        message: "查询超过 5 秒",
      },
      { type: "done", runId: "r_002", elapsedMs: 5001, attempts: 1, llmCalls: 1, tokens: { input: 900, output: 40 }, costCny: 0.002 },
    ];
    const s = reduceEvents(events);

    expect(s.phase).toBe("failed");
    expect(s.finished).toBe(true);
    expect(s.error?.code).toBe("TIMEOUT");
    // done 必发 —— 即使失败路径，前端也能解除 loading
    expect(s.stats?.elapsedMs).toBe(5001);
  });

  it("text_delta 逐段拼接", () => {
    let s: RunState = emptyRunState();
    for (const e of [
      { type: "run_started", runId: "r_003", asOfDate: "2026-08-31" },
      { type: "text_delta", delta: "上个月销" },
      { type: "text_delta", delta: "售额最高的是" },
      { type: "text_delta", delta: "手机数码" },
    ] as CaliberEvent[]) {
      s = reduceEvent(s, e);
    }
    expect(s.summaryText).toBe("上个月销售额最高的是手机数码");
  });

  it("拒答态：reasons 与澄清选项进入状态", () => {
    const events: CaliberEvent[] = [
      { type: "run_started", runId: "r_004", asOfDate: "2026-08-31" },
      {
        type: "state",
        verdict: "refused",
        reasons: ["问题涉及的实体（工资）在数据源中不存在"],
        clarifications: [
          { label: "查看可查询的表", description: "customers / products / orders / order_items" },
        ],
      },
      { type: "done", runId: "r_004", elapsedMs: 800, attempts: 1, llmCalls: 1, tokens: { input: 700, output: 90 }, costCny: 0.001 },
    ];
    const s = reduceEvents(events);

    expect(s.verdict).toBe("refused");
    expect(s.verdictReasons).toHaveLength(1);
    expect(s.clarifications[0].label).toBe("查看可查询的表");
  });

  it("空事件流得到合法的初始状态", () => {
    const s = reduceEvents([]);
    expect(s.phase).toBe("understanding");
    expect(s.finished).toBe(false);
    expect(s.attempts).toHaveLength(0);
  });
});
