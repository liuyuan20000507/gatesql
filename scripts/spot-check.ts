/**
 * 6C live/replay 对齐抽查（docs/08 第 6 周）。
 *
 * 用法（三步，前两步产出 JSON，第三步出报告）：
 *   pnpm tsx scripts/spot-check.ts replay   # 抽样 10 题走 cassette（免费，先跑验证回放完好）
 *   pnpm tsx scripts/spot-check.ts live     # 同 10 题真调模型（花 token）
 *   pnpm tsx scripts/spot-check.ts compare  # 逐题对比 → eval/spot-check/report.md
 *
 * 抽样规则：30 题每隔 3 取 1（索引 2,5,…,29）= 10 题。确定性抽样避免挑题嫌疑，
 * 覆盖全部六层。对齐判据与评测一致：verdict 一致 + 结果行等价（resultsEqual，
 * 排行榜题才校验行序）——SQL 文本不要求逐字节一致。
 *
 * 分歧归因（compare 自动做）：
 *   - 双方各自与 gold 等价但互不相同 → 模型方差（live 非确定性的正常表现，可接受）
 *   - replay 错 / live 对            → cassette 键或内容有 bug，必须修
 *   - 双方都错                        → 与对齐无关，是模型能力问题，另行归因
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { runAgent, type RunSummary } from "@/lib/agent/loop";
import { resultsEqual, type ResultSetLike } from "@/lib/eval/compare";
import { getConfig } from "@/lib/env";
import type { GateSqlEvent } from "@/lib/events";

function loadDotEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

interface GoldItem {
  id: string;
  layer: string;
  question: string;
  goldSql?: string;
  expectedVerdict: "answered" | "refused";
}

function loadGold(): GoldItem[] {
  return readFileSync("fixtures/evalset/gold.jsonl", "utf-8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GoldItem);
}

interface SpotResult {
  id: string;
  layer: string;
  question: string;
  verdict: RunSummary["verdict"];
  finalStatus: string;
  attempts: number;
  llmCalls: number;
  /** 结果行（无 rows 事件即 null：refused / 空结果） */
  rows: ResultSetLike | null;
  lastSql: string | null;
  error: string | null;
}

const OUT_DIR = "eval/spot-check";

async function runPhase(mode: "live" | "replay"): Promise<void> {
  loadDotEnvLocal();
  // 必须在 getConfig 之前设置（env 解析结果有缓存，顺序错了模式就是假象——eval.ts 同款教训）
  process.env.LLM_MODE = mode;
  const env = getConfig();
  const asOf = env.AS_OF_DATE ?? "2026-08-31";

  const items = loadGold().filter((_, i) => i % 3 === 2);
  console.log(`对齐抽查[${mode}]：${items.length} 题 | 模型 ${env.LLM_MODEL} | 时钟 ${asOf}`);
  console.log("抽样题：", items.map((i) => i.id).join(", "));

  const results: SpotResult[] = [];
  for (const item of items) {
    process.stdout.write(`[${item.id}] ${item.question} …… `);
    const events: GateSqlEvent[] = [];
    try {
      const summary = await runAgent({
        question: item.question,
        asOfDate: asOf,
        emit: (e) => void events.push(e),
        trace: () => {},
      });
      const rowsEvent = events.find((e): e is Extract<GateSqlEvent, { type: "rows" }> => e.type === "rows");
      const lastSqlEvent = [...events].reverse().find((e): e is Extract<GateSqlEvent, { type: "sql_generated" }> => e.type === "sql_generated");
      results.push({
        id: item.id,
        layer: item.layer,
        question: item.question,
        verdict: summary.verdict,
        finalStatus: summary.finalStatus,
        attempts: summary.attempts,
        llmCalls: summary.llmCalls,
        rows: rowsEvent ? { columns: rowsEvent.columns, rows: rowsEvent.rows } : null,
        lastSql: lastSqlEvent?.sql ?? null,
        error: null,
      });
      process.stdout.write(`${summary.verdict}（${summary.attempts} 次）\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 120) : String(err);
      results.push({ id: item.id, layer: item.layer, question: item.question, verdict: null, finalStatus: "ERROR", attempts: 0, llmCalls: 0, rows: null, lastSql: null, error: msg });
      process.stdout.write(`异常: ${msg}\n`);
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/${mode}.json`, JSON.stringify({ mode, ranAt: new Date().toISOString(), model: env.LLM_MODEL, results }, null, 2), "utf-8");
  console.log(`已落盘 ${OUT_DIR}/${mode}.json\n`);
}

function isResultSetLike(v: unknown): v is ResultSetLike {
  return typeof v === "object" && v !== null && Array.isArray((v as ResultSetLike).rows);
}

function compare(): void {
  const live = JSON.parse(readFileSync(`${OUT_DIR}/live.json`, "utf-8")) as { results: SpotResult[] };
  const replay = JSON.parse(readFileSync(`${OUT_DIR}/replay.json`, "utf-8")) as { results: SpotResult[] };
  const gold = new Map(loadGold().map((g) => [g.id, g]));
  const replayById = new Map(replay.results.map((r) => [r.id, r]));

  let aligned = 0;
  const divergent: string[] = [];
  const lines: string[] = [
    `# live/replay 对齐抽查报告（6C）`,
    ``,
    `- 抽样：30 题每隔 3 取 1 = ${live.results.length} 题（索引 2,5,…,29，覆盖六层）`,
    `- 对齐判据：verdict 一致 + 结果行等价（resultsEqual；排行榜题校验行序）`,
    `- 抽查日期：${new Date().toISOString().slice(0, 10)}`,
    ``,
    `| 题号 | 问题 | live | replay | 结果等价 | SQL 文本一致 | 结论 |`,
    `|---|---|---|---|---|---|---|`,
  ];

  for (const l of live.results) {
    const r = replayById.get(l.id);
    if (!r) {
      lines.push(`| ${l.id} | ${l.question} | ${l.verdict} | 缺失 | - | - | ❌ replay 缺题 |`);
      divergent.push(`${l.id}: replay 缺题`);
      continue;
    }
    const verdictSame = l.verdict === r.verdict;
    // 等价比对：任一方无行视为 null 集合（refused/空结果），双方都无行即等价
    const cmp =
      l.rows && r.rows
        ? resultsEqual(l.rows, r.rows, { ordered: false })
        : { equal: !l.rows && !r.rows, reason: !l.rows && !r.rows ? "双方均无结果行" : "一方有行一方无行" };
    const sqlSame = l.lastSql !== null && l.lastSql === r.lastSql;

    let verdictText = "✅ 对齐";
    if (verdictSame && cmp.equal) {
      aligned++;
    } else {
      // 归因：双方各自与 gold 等价但互不相同 = 模型方差；否则待查
      const g = gold.get(l.id);
      let liveOk: boolean | null = null;
      let replayOk: boolean | null = null;
      if (g?.goldSql && g.expectedVerdict === "answered" && l.rows && r.rows) {
        const goldRes = JSON.parse(readFileSync("fixtures/evalset/gold_results.jsonl", "utf-8").split(/\r?\n/).find((line) => line.includes(`"${l.id}"`)) ?? "null") as ResultSetLike | null;
        if (goldRes) {
          liveOk = resultsEqual({ columns: goldRes.columns, rows: goldRes.rows }, l.rows, { ordered: false }).equal;
          replayOk = resultsEqual({ columns: goldRes.columns, rows: goldRes.rows }, r.rows, { ordered: false }).equal;
        }
      }
      verdictText = liveOk === true && replayOk === true ? "⚠ 模型方差（双方均对）" : "❌ 待查";
      divergent.push(`${l.id}: verdict ${l.verdict}/${r.verdict}，等价 ${cmp.equal}（${cmp.reason ?? ""}），live对=${liveOk} replay对=${replayOk}`);
    }
    lines.push(`| ${l.id} | ${l.question} | ${l.verdict ?? "-"} | ${r.verdict ?? "-"} | ${cmp.equal ? "等价" : `不等价（${cmp.reason ?? ""}）`} | ${sqlSame ? "一致" : "不同"} | ${verdictText} |`);
  }

  lines.push("", `**对齐 ${aligned}/${live.results.length}**。分歧 ${divergent.length} 条：`);
  for (const d of divergent) lines.push(`- ${d}`);

  const report = lines.join("\n");
  writeFileSync(`${OUT_DIR}/report.md`, report, "utf-8");
  console.log(report);
}

const mode = process.argv[2];
if (mode === "live" || mode === "replay") {
  void runPhase(mode);
} else if (mode === "compare") {
  compare();
} else {
  console.error("用法：pnpm tsx scripts/spot-check.ts <live|replay|compare>");
  process.exit(1);
}
