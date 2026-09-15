/**
 * gold 自检（3B）：逐条执行 gold.jsonl 的 goldSql，验证可执行、锚点数字、lint 0 块违规；
 * 再按 crosscheck.jsonl 用「结构不同的第二写法」交叉验算金额类结果（docs/06 一节的欠账清偿）。
 *
 * 用法：pnpm tsx scripts/check-gold.ts
 */

import { existsSync, readFileSync } from "node:fs";

import { DatabaseSync } from "node:sqlite";

import { resultsEqual, type ResultSetLike } from "@/lib/eval/compare";
import { lintCaliber } from "@/lib/sql/lint";

interface GoldItem {
  id: string;
  layer: string;
  question: string;
  goldSql?: string;
  expectedVerdict: "answered" | "refused";
  notes?: string;
}

const gold: GoldItem[] = readFileSync("fixtures/evalset/gold.jsonl", "utf-8")
  .split(/\r?\n/)
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as GoldItem);

const db = new DatabaseSync("data/shop.db", { readOnly: true });

let failed = 0;
const anchors: Record<string, string> = {
  A1: "500", A2: "30", A3: "8110", A4: "41015358.75", D1: "41015358.75", D3: "5057.38",
};

for (const g of gold) {
  if (!g.goldSql) {
    console.log(`[${g.id}] ${g.expectedVerdict} 题，无 goldSql，跳过`);
    continue;
  }
  try {
    const stmt = db.prepare(g.goldSql);
    const rows = stmt.all() as Array<Record<string, unknown>>;
    const cols = stmt.columns().map((c) => c.name);
    const lint = lintCaliber(g.goldSql, { timeKeywords: [], rankKeywords: [] });
    const blocks = lint.violations.filter((v) => v.level === "block");
    const warns = lint.violations.filter((v) => v.level === "warn");
    const lintTag = blocks.length > 0 ? `BLOCK:${blocks.map((v) => v.ruleId).join(",")}` : warns.length > 0 ? `warn:${warns.map((v) => v.ruleId).join(",")}` : "clean";
    const first = rows[0] ? JSON.stringify(rows[0]) : "(空)";
    let anchorTag = "";
    const anchor = anchors[g.id];
    if (anchor) {
      const val = rows[0] ? Object.values(rows[0])[0] : null;
      // 锚点是四舍五入到 2 位的展示值，除法类结果带完整小数，用数值容差比较
      const ok = val !== null && Number.isFinite(Number(val)) && Math.abs(Number(val) - Number(anchor)) < 0.005;
      anchorTag = ok ? " | 锚点✓" : ` | 锚点✗ 期望 ${anchor} 实得 ${val}`;
      if (!ok) failed++;
    }
    if (blocks.length > 0) failed++;
    console.log(`[${g.id}] ${rows.length} 行 ${cols.join("/")} | lint ${lintTag}${anchorTag} | 首行 ${first}`);
  } catch (err) {
    failed++;
    console.log(`[${g.id}] 执行失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

db.close();
console.log(failed === 0 ? "\n主体检查全部通过" : `\n主体检查 ${failed} 条未通过`);

/* ------------------------------------------------------------------ */
/* 交叉验算：第二写法（结构不同）必须与 gold 结果等价                     */
/* ------------------------------------------------------------------ */

interface CrossItem {
  id: string;
  altSql: string;
  note?: string;
}

if (existsSync("fixtures/evalset/crosscheck.jsonl")) {
  const cross: CrossItem[] = readFileSync("fixtures/evalset/crosscheck.jsonl", "utf-8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as CrossItem);
  const goldById = new Map(gold.map((g) => [g.id, g]));
  const db2 = new DatabaseSync("data/shop.db", { readOnly: true });

  const exec = (sql: string): ResultSetLike => {
    const stmt = db2.prepare(sql);
    const objs = stmt.all() as Array<Record<string, unknown>>;
    const cols = stmt.columns().map((c) => c.name);
    return { columns: cols, rows: objs.map((o) => cols.map((c) => (o[c] === undefined ? null : (o[c] ?? null)))) };
  };

  let crossFailed = 0;
  for (const c of cross) {
    const g = goldById.get(c.id);
    if (!g?.goldSql) {
      console.log(`[cross ${c.id}] ✗ gold 无 goldSql`);
      crossFailed++;
      continue;
    }
    try {
      const r = resultsEqual(exec(g.goldSql), exec(c.altSql), {
        ordered: /order\s+by/i.test(g.goldSql) && /limit\s+\d/i.test(g.goldSql),
      });
      if (r.equal) {
        console.log(`[cross ${c.id}] ✓ 两写法等价（${c.note ?? ""}）`);
      } else {
        console.log(`[cross ${c.id}] ✗ 不等价: ${r.reason}`);
        crossFailed++;
      }
    } catch (err) {
      console.log(`[cross ${c.id}] ✗ 执行失败: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
      crossFailed++;
    }
  }
  db2.close();
  console.log(crossFailed === 0 ? `交叉验算全部通过（${cross.length} 题）` : `交叉验算 ${crossFailed} 题未通过`);
  failed += crossFailed;
}

process.exit(failed === 0 ? 0 : 1);
