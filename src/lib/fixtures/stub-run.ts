/**
 * 第 1 周桩接口的剧本：不调模型、不查库，按契约顺序推写死的事件。
 *
 * 剧本选了「第 1 次被口径规则拦下、第 2 次修复成功」的重试场景 ——
 * 这正是第 2 周真 agent 的招牌演示，前端从第一天起就在为它开发。
 *
 * 第 2 周用真 agent 替换 buildStubRun 的调用处，前端一行不用改；
 * 如果需要改前端，说明契约没被遵守，回去对照 docs/03-api-contract.md。
 */

import type { CaliberEvent } from "@/lib/events";

export function buildStubRun(runId: string, asOfDate = "2026-08-31"): CaliberEvent[] {
  return [
    { type: "run_started", runId, asOfDate },

    {
      type: "time_resolved",
      expression: "2026年上半年",
      from: "2026-01-01",
      to: "2026-06-30",
      display: "已理解为 2026-01-01 ~ 2026-06-30",
    },

    { type: "context_built", tables: ["orders", "order_items", "products"], fewshotIds: [] },

    {
      type: "sql_generated",
      attempt: 1,
      sql:
        "SELECT p.category, SUM(oi.amount) AS revenue\n" +
        "FROM order_items oi\n" +
        "JOIN orders o ON o.id = oi.order_id\n" +
        "JOIN products p ON p.id = oi.product_id\n" +
        "-- ⚠ 漏了订单状态过滤",
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
          suggestion: "金额类聚合必须约束订单状态，否则已取消和已退款订单会被计入",
        },
      ],
    },

    {
      type: "sql_generated",
      attempt: 2,
      sql:
        "SELECT p.category, SUM(oi.amount) AS revenue\n" +
        "FROM order_items oi\n" +
        "JOIN orders o ON o.id = oi.order_id\n" +
        "JOIN products p ON p.id = oi.product_id\n" +
        "WHERE o.status = '已完成'\n" +
        "GROUP BY p.category\n" +
        "ORDER BY revenue DESC",
      citedRules: ["R1"],
    },

    { type: "lint_result", attempt: 2, violations: [] },

    {
      type: "rows",
      columns: ["category", "revenue"],
      rows: [
        ["手机数码", 12890050.5],
        ["电脑办公", 9812000.0],
        ["家用电器", 8456000.25],
        ["服饰鞋包", 5623400.75],
        ["食品生鲜", 4233907.25],
      ],
      rowCount: 5,
      truncated: false,
      elapsedMs: 34,
    },

    {
      type: "verification",
      checks: [
        { kind: "empty_result", passed: true, detail: "结果非空" },
        { kind: "suspicious_shape", passed: true, detail: "行数远小于 LIMIT，未见静默截断" },
        { kind: "magnitude", passed: true, detail: "占总销售额 100.0%，量级正常" },
      ],
    },

    {
      type: "receipt",
      scope: "2026-01-01 至 2026-06-30",
      filters: ["订单状态=已完成，已排除已取消 1873 单、已退款 2017 单"],
      method: "明细行按含折扣成交价小计求和",
      dataUntil: "2026-08-31",
      coverage: "参与计算 4203 单、7891 明细行",
      fullyTranslated: true,
    },

    { type: "state", verdict: "verified", reasons: [] },

    { type: "chart", spec: { kind: "bar", x: "category", y: ["revenue"], title: "2026 上半年分类销售额" } },

    { type: "text_delta", delta: "2026 年上半年，" },
    { type: "text_delta", delta: "销售额最高的是手机数码，" },
    { type: "text_delta", delta: "达 1289 万元。" },
    { type: "text_delta", delta: "五个分类合计" },
    { type: "text_delta", delta: "占店铺总销售额的全部（本表仅统计这五类）。" },
    { type: "text_delta", delta: "以上数字已按「已完成」口径核验，" },
    { type: "text_delta", delta: "详见口径回执。" },

    {
      type: "done",
      runId,
      elapsedMs: 4210,
      attempts: 2,
      llmCalls: 3,
      tokens: { input: 5100, output: 780 },
      costCny: 0.031,
    },
  ];
}
