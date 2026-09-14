/**
 * 一次性排查工具（3E/3F 用）：用 replay 模式重放指定错题，把 agent 实际写的
 * SQL 与结果导出到 trace-dump.txt（评测直连 runAgent，不走 /api/chat，
 * 事件不落库 —— 所以这里主动重放抓事件）。
 *
 * 用法：pnpm tsx scripts/dump-wrong-traces.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { runAgent } from "@/lib/agent/loop";

const TARGETS = ["C3", "C4", "D2", "D4", "E4", "F1", "F3"];

interface GoldItem {
  id: string;
  question: string;
}

function loadDotEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

async function main(): Promise<void> {
  loadDotEnvLocal();
  process.env.LLM_MODE = "replay"; // 用基线时录好的 cassette，确定性重放

  const gold: GoldItem[] = readFileSync("fixtures/evalset/gold.jsonl", "utf-8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GoldItem);

  const lines: string[] = [];
  for (const g of gold.filter((x) => TARGETS.includes(x.id))) {
    lines.push("=".repeat(72));
    lines.push(`[${g.id}] ${g.question}`);
    const events = [];
    const summary = await runAgent({
      question: g.question,
      asOfDate: "2026-08-31",
      emit: (event) => void events.push(event),
      trace: () => {},
    });
    lines.push(`verdict: ${summary.verdict} | final: ${summary.finalStatus}`);
    for (const event of events) {
      if (event.type === "sql_generated") {
        lines.push(`--- agent 的 SQL（第 ${event.attempt ?? "?"} 次）---\n${event.sql}`);
      } else if (event.type === "rows") {
        lines.push(`--- 结果（${event.rowCount} 行，截断=${event.truncated}）---`);
        lines.push(`columns: ${JSON.stringify(event.columns)}`);
        for (const r of event.rows.slice(0, 10)) lines.push(JSON.stringify(r));
        if (event.rowCount > 10) lines.push("…（其余略）");
      } else if (event.type === "lint_result" && event.violations.length > 0) {
        lines.push(`--- lint ---\n${JSON.stringify(event.violations, null, 2)}`);
      }
    }
  }

  writeFileSync("trace-dump.txt", lines.join("\n"), "utf-8");
  console.log("已写入 trace-dump.txt");
}

main().catch((err) => {
  console.error("导出失败:", err);
  process.exit(1);
});
