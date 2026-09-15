/**
 * 4F 实验的 few-shot 种子样本（幂等：INSERT OR REPLACE，可重复执行）。
 *
 * 诚实性纪律（重要）：
 *   - 样本一律不用评测集里的 30 题 —— 同题示例等于把答案抄给模型，A/B 数字就废了
 *   - 示例只覆盖「结构模式」（状态过滤 / 去重计数 / 时间区间 / NULL 分组），
 *     数值场景全部与评测题不同
 *   - verified_by_user=1：这三条 SQL 都是本 agent 答对的 trace 同款写法，人工核对过
 *
 * 用法：pnpm tsx scripts/seed-corrections.ts
 */

import { existsSync, readFileSync } from "node:fs";

import { openAppDb, saveCorrection } from "@/lib/db/app";
import { getConfig } from "@/lib/env";

function loadDotEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const SEED = [
  {
    id: "few_ex_status",
    question: "钻石会员的已完成订单一共有多少笔？",
    sql: "SELECT COUNT(DISTINCT o.id) AS order_count FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = '已完成' AND c.level = '钻石'",
    tables: ["orders", "customers"],
    keywords: ["订单", "已完成", "会员"],
  },
  {
    id: "few_ex_timerange",
    question: "2025 年 11 月被取消的订单有多少笔？",
    sql: "SELECT COUNT(*) AS cancelled_orders FROM orders WHERE status = '已取消' AND created_at >= '2025-11-01' AND created_at < '2025-12-01'",
    tables: ["orders"],
    keywords: ["订单", "取消", "月份"],
  },
  {
    id: "few_ex_aggjoin",
    question: "各分类商品一共卖出了多少件？（含所有状态订单）",
    sql: "SELECT p.category, SUM(oi.quantity) AS total_quantity FROM order_items oi JOIN products p ON p.id = oi.product_id GROUP BY p.category ORDER BY total_quantity DESC",
    tables: ["order_items", "products"],
    keywords: ["分类", "件数", "销量"],
  },
];

loadDotEnvLocal();
const env = getConfig();
const db = openAppDb(env.APP_DB_PATH);
try {
  const now = new Date().toISOString();
  for (const s of SEED) {
    db.prepare("DELETE FROM corrections WHERE id = ?").run(s.id);
    saveCorrection(db, { id: s.id, question: s.question, sql: s.sql, tables: s.tables, keywords: s.keywords, createdAt: now });
    db.prepare("UPDATE corrections SET verified_by_user = 1 WHERE id = ?").run(s.id);
  }
  console.log(`已种入 ${SEED.length} 条 verified few-shot 样本（corrections 表）`);
} finally {
  db.close();
}
