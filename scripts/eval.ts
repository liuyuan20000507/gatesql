/**
 * 评测脚本：30 题逐题跑完整 agent（含自愈），与 gold 比对，输出分层报告。
 *
 * 用法：
 *   pnpm eval            # 全量 30 题（默认 record 模式：真调模型并录制 cassette）
 *   pnpm eval:quick      # 前 10 题
 *   LLM_MODE=replay pnpm eval   # 用已录 cassette 离线重跑（<60s、零成本）
 *
 * 评分规则（docs/06-evaluation.md）：
 *   - answered 题：agent 有 rows 且与 gold 结果等价 → 通过
 *   - refused 题：agent verdict === refused → 通过；给出任何答案 = 自信错答
 *   - 指标只看执行结果，不比 SQL 文本
 *
 * gold 文件：fixtures/evalset/gold.jsonl，每行一个 JSON：
 *   {"id":"A1","layer":"简单聚合","question":"...","goldSql":"SELECT ...","expectedVerdict":"answered"}
 *   {"id":"E1","layer":"不可答","question":"...","expectedVerdict":"refused"}
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";

import { runAgent, type RunSummary } from "@/lib/agent/loop";
import { createEvalRun, openAppDb, recordEvalItem } from "@/lib/db/app";
import { resultsEqual, type ResultSetLike } from "@/lib/eval/compare";
import { getConfig } from "@/lib/env";
import type { CaliberEvent } from "@/lib/events";

/**
 * 显式加载 .env.local —— 它是 Next 的约定，tsx 脚本不会自动读取。
 * 不加载的话脚本进程里没有 LLM_API_KEY，callLlm 会静默退回 replay 模式
 * （实测踩过：报告打印 record、实际全在报找不到 cassette）。
 */
function loadDotEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

/* ------------------------------------------------------------------ */
/* gold 读取                                                           */
/* ------------------------------------------------------------------ */

interface GoldItem {
  id: string;
  layer: string;
  question: string;
  goldSql?: string;
  expectedVerdict: "answered" | "refused";
  notes?: string;
}

function loadGold(): GoldItem[] {
  const raw = readFileSync("fixtures/evalset/gold.jsonl", "utf-8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as GoldItem);
}

/* ------------------------------------------------------------------ */
/* gold 执行（app 层可信查询：独立只读连接，不走 guard/agent 链路）       */
/* ------------------------------------------------------------------ */

function executeGold(goldSql: string, dbPath: string): ResultSetLike {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare(goldSql);
    const objects = stmt.all() as Array<Record<string, unknown>>;
    const columns = stmt.columns().map((c) => c.name);
    return {
      columns,
      rows: objects.map((o) => columns.map((c) => (o[c] === undefined ? null : (o[c] ?? null)))),
    };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* 单题执行                                                             */
/* ------------------------------------------------------------------ */

interface QuestionOutcome {
  events: CaliberEvent[];
  summary: RunSummary;
}

async function runQuestion(question: string, asOfDate: string): Promise<QuestionOutcome> {
  const events: CaliberEvent[] = [];
  const summary = await runAgent({
    question,
    asOfDate,
    emit: (event) => void events.push(event),
    trace: () => {},
  });
  return { events, summary };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  loadDotEnvLocal();
  // 必须在 getConfig() 之前设置 —— env 解析结果会被缓存，顺序错了
  // 「模式 record」就只是打印出来的假象，实际走 live 且不录 cassette（实测踩过）
  if (!process.env.LLM_MODE) process.env.LLM_MODE = "record";
  const env = getConfig();

  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : undefined;

  const gold = loadGold();
  const items = limit ? gold.slice(0, limit) : gold;
  const mode = process.env.LLM_MODE;
  const asOf = env.AS_OF_DATE ?? "2026-08-31";

  console.log(`评测开始：${items.length} 题 | 模型 ${env.LLM_MODEL} | 模式 ${mode} | 时钟 ${asOf}`);
  console.log("=".repeat(64));

  const evalRunId = `eval_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
  const outcomes: Array<{ item: GoldItem; pass: boolean; verdict: RunSummary["verdict"]; failReason: string | null; summary: RunSummary | null }> = [];

  for (const item of items) {
    process.stdout.write(`[${item.id}] ${item.question} …… `);
    let failReason: string | null = null;
    let summary: RunSummary | null = null;
    let verdict: RunSummary["verdict"] = null;

    try {
      const { events, summary: s } = await runQuestion(item.question, asOf);
      summary = s;
      verdict = s.verdict;

      const rowsEvent = events.find((e) => e.type === "rows");
      const agentResult: ResultSetLike | null = rowsEvent
        ? { columns: rowsEvent.columns, rows: rowsEvent.rows }
        : null;

      if (item.expectedVerdict === "refused") {
        if (verdict === "refused") {
          process.stdout.write("✓ 正确拒答\n");
          outcomes.push({ item, pass: true, verdict, failReason: null, summary });
        } else {
          failReason = `应拒答却给出了答案（verdict=${verdict ?? "无"}）`;
          process.stdout.write(`✗ ${failReason}\n`);
          outcomes.push({ item, pass: false, verdict, failReason, summary });
        }
      } else {
        if (!agentResult) {
          failReason = `没有 rows 事件（verdict=${verdict ?? "无"}，final=${s.finalStatus}）`;
          process.stdout.write(`✗ ${failReason}\n`);
          outcomes.push({ item, pass: false, verdict, failReason, summary });
        } else {
          const goldResult = executeGold(item.goldSql!, env.SHOP_DB_PATH);
          const cmp = resultsEqual(goldResult, agentResult, {
            ordered: /order\s+by/i.test(item.goldSql!),
          });
          if (cmp.equal) {
            process.stdout.write("✓ 与 gold 等价\n");
            outcomes.push({ item, pass: true, verdict, failReason: null, summary });
          } else {
            failReason = cmp.reason ?? "结果不等价";
            process.stdout.write(`✗ ${failReason}\n`);
            outcomes.push({ item, pass: false, verdict, failReason, summary });
          }
        }
      }
    } catch (err) {
      failReason = `执行异常: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
      process.stdout.write(`✗ ${failReason}\n`);
      outcomes.push({ item, pass: false, verdict, failReason, summary: null });
    }
  }

  /* ---------------- 汇总指标 ---------------- */

  const total = outcomes.length;
  const passed = outcomes.filter((o) => o.pass).length;
  const accuracy = total > 0 ? passed / total : 0;
    // 拒答率只度量「过度拒答」：本可回答（expected=answered）却 refused 的比例。
  // 不可答题的正确拒答不计入 —— 否则题集里 5 道不可答题全答对也会撞破 12% 上限。
  const answeredOutcomes = outcomes.filter((o) => o.item.expectedVerdict === "answered");
  const answeredRefusals = answeredOutcomes.filter((o) => o.verdict === "refused").length;
  const refusalRate = answeredOutcomes.length > 0 ? answeredRefusals / answeredOutcomes.length : 0;
  // 自信错答：expected=answered 却标 verified 但错；expected=refused 却给了任何答案
  const overconfident = outcomes.filter(
    (o) =>
      (o.item.expectedVerdict === "answered" && o.verdict === "verified" && !o.pass) ||
      (o.item.expectedVerdict === "refused" && o.verdict !== "refused"),
  ).length;
  const overconfidentRate = total > 0 ? overconfident / total : 0;
  const withSummary = outcomes.filter((o) => o.summary !== null);
  const avgAttempts = withSummary.length > 0 ? withSummary.reduce((s, o) => s + (o.summary?.attempts ?? 0), 0) / withSummary.length : 0;
  const avgElapsedMs = withSummary.length > 0 ? withSummary.reduce((s, o) => s + (o.summary?.elapsedMs ?? 0), 0) / withSummary.length : 0;
  const totalInputTokens = outcomes.reduce((s, o) => s + (o.summary?.inputTokens ?? 0), 0);
  const totalOutputTokens = outcomes.reduce((s, o) => s + (o.summary?.outputTokens ?? 0), 0);

  const layerStats = new Map<string, { total: number; passed: number }>();
  for (const o of outcomes) {
    const stat = layerStats.get(o.item.layer) ?? { total: 0, passed: 0 };
    stat.total++;
    if (o.pass) stat.passed++;
    layerStats.set(o.item.layer, stat);
  }

  /* ---------------- 报告 ---------------- */

  console.log("\n" + "=".repeat(64));
  console.log(`总准确率: ${passed}/${total} = ${(accuracy * 100).toFixed(1)}%`);
  console.log(`拒答率(仅统计可答题): ${(refusalRate * 100).toFixed(1)}%（硬上限 12%）`);
  console.log(`自信错答率: ${(overconfidentRate * 100).toFixed(1)}%`);
  console.log(`平均尝试: ${avgAttempts.toFixed(2)} 次 | 平均耗时: ${avgElapsedMs.toFixed(0)} ms`);
  console.log(`tokens: in ${totalInputTokens} / out ${totalOutputTokens}`);
  console.log("\n分层：");
  for (const [layer, stat] of layerStats) {
    console.log(`  ${layer}: ${stat.passed}/${stat.total}`);
  }
  const wrong = outcomes.filter((o) => !o.pass);
  if (wrong.length > 0) {
    console.log("\n错题清单：");
    for (const o of wrong) {
      console.log(`  [${o.item.id}] ${o.item.question} —— ${o.failReason}`);
    }
  }

  /* ---------------- 落库（eval_runs / eval_items） ---------------- */

  const appDb = openAppDb(env.APP_DB_PATH);
  try {
    createEvalRun(appDb, {
      id: evalRunId,
      ranAt: new Date().toISOString(),
      model: env.LLM_MODEL,
      llmMode: mode,
      total,
      passed,
      accuracy,
      refusalRate,
      overconfidentRate,
      avgAttempts,
      avgElapsedMs,
      totalInputTokens,
      totalOutputTokens,
    });
    for (const o of outcomes) {
      recordEvalItem(appDb, {
        evalRunId,
        questionId: o.item.id,
        layer: o.item.layer,
        passed: o.pass,
        agentVerdict: o.verdict,
        goldExpected: o.item.expectedVerdict,
        attempts: o.summary?.attempts ?? null,
        elapsedMs: o.summary?.elapsedMs ?? null,
        inputTokens: o.summary?.inputTokens ?? null,
        outputTokens: o.summary?.outputTokens ?? null,
        failReason: o.failReason,
      });
    }
    console.log(`\n已落库: ${evalRunId}（eval_runs / eval_items）`);
  } finally {
    appDb.close();
  }
}

main().catch((err) => {
  console.error("评测脚本异常:", err);
  process.exit(1);
});