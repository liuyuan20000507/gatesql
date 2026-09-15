/**
 * 生成 gold 结果快照（docs/08 第 3 周「gold 以 SQL + 执行结果两份存储」欠账清偿）。
 *
 * 结果由脚本从 shop.db 执行生成、绝不手抄。用途：
 *   - fixtures/evalset/gold_results.jsonl 是「gold SQL ⊕ 当前数据库」的联合指纹；
 *   - pnpm eval 每次跑前把现算结果与快照比对 —— seed 数据被意外重新生成、
 *     或 gold SQL 被改动而忘记重录时，评测立即报错而不是安静地拿错基准打分。
 *
 * 用法：pnpm tsx scripts/build-gold-results.ts   （改了 gold 或 seed 之后重跑）
 */

import { readFileSync, writeFileSync } from "node:fs";

import { DatabaseSync } from "node:sqlite";

interface GoldItem {
  id: string;
  goldSql?: string;
}

const gold: GoldItem[] = readFileSync("fixtures/evalset/gold.jsonl", "utf-8")
  .split(/\r?\n/)
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as GoldItem);

const db = new DatabaseSync("data/shop.db", { readOnly: true });
const out: string[] = [];
try {
  for (const g of gold) {
    if (!g.goldSql) continue;
    const stmt = db.prepare(g.goldSql);
    const rows = stmt.all() as Array<Record<string, unknown>>;
    const columns = stmt.columns().map((c) => c.name);
    out.push(
      JSON.stringify({
        id: g.id,
        columns,
        rows: rows.map((r) => columns.map((c) => (r[c] === undefined ? null : (r[c] ?? null)))),
      }),
    );
  }
} finally {
  db.close();
}

writeFileSync("fixtures/evalset/gold_results.jsonl", out.join("\n") + "\n", "utf-8");
console.log(`已生成 gold 结果快照：${out.length} 题 → fixtures/evalset/gold_results.jsonl`);
