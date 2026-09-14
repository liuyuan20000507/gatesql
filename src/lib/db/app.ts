/**
 * app.db 访问层（应用自身的库，读写）。
 *
 * 规则（docs/04-data-model.md 第三节）：
 *   1. 所有 SQL 收敛到本文件，其他模块一律通过这里的函数访问；
 *   2. 表对应的 TS 类型见 src/types/db.ts；
 *   3. 不在热路径上同步写 —— loop 负责在流结束后批量 flush。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import { getConfig } from "@/lib/env";
import type { CaliberEvent } from "@/lib/events";

const SCHEMA_SQL = readFileSync(path.join(process.cwd(), "src", "lib", "db", "schema.sql"), "utf-8");

/* ------------------------------------------------------------------ */
/* 建表与连接                                                          */
/* ------------------------------------------------------------------ */

/** 打开（必要时创建）app.db 并确保表结构存在 */
export function openAppDb(dbPath: string = getConfig().APP_DB_PATH): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  return db;
}

/* ------------------------------------------------------------------ */
/* runs                                                                */
/* ------------------------------------------------------------------ */

export interface NewRunInput {
  id: string;
  question: string;
  asOfDate: string;
  llmMode: "live" | "record" | "replay";
  createdAt: string;
}

export function createRun(db: DatabaseSync, input: NewRunInput): void {
  db.prepare(
    `INSERT INTO runs (id, question, as_of_date, llm_mode, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.id, input.question, input.asOfDate, input.llmMode, input.createdAt);
}

export interface FinishRunInput {
  id: string;
  verdict: string;
  verdictReasons: string[];
  finalStatus: string;
  attempts: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}

export function finishRun(db: DatabaseSync, input: FinishRunInput): void {
  db.prepare(
    `UPDATE runs SET
       verdict = ?, verdict_reasons = ?, final_status = ?,
       attempts = ?, llm_calls = ?, input_tokens = ?, output_tokens = ?,
       elapsed_ms = ?
     WHERE id = ?`,
  ).run(
    input.verdict,
    JSON.stringify(input.verdictReasons),
    input.finalStatus,
    input.attempts,
    input.llmCalls,
    input.inputTokens,
    input.outputTokens,
    input.elapsedMs,
    input.id,
  );
}

export interface RunRow {
  id: string;
  question: string;
  as_of_date: string;
  verdict: string | null;
  final_status: string | null;
  attempts: number;
  llm_calls: number;
  elapsed_ms: number;
  created_at: string;
}

export function listRuns(db: DatabaseSync, limit = 50): RunRow[] {
  return db
    .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as RunRow[];
}

/* ------------------------------------------------------------------ */
/* steps                                                               */
/* ------------------------------------------------------------------ */

export type StepKind =
  | "llm_call"
  | "sql_attempt"
  | "guard"
  | "lint"
  | "eqp"
  | "execute"
  | "verify"
  | "receipt";

export interface NewStepInput {
  runId: string;
  seq: number;
  kind: StepKind;
  startedAt: number;
  endedAt?: number;
  status: "ok" | "rejected" | "failed";
  attributes: Record<string, unknown>;
}

export function insertStep(db: DatabaseSync, input: NewStepInput): void {
  db.prepare(
    `INSERT INTO steps (run_id, seq, kind, started_at, ended_at, status, attributes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.seq,
    input.kind,
    input.startedAt,
    input.endedAt ?? null,
    input.status,
    JSON.stringify(input.attributes),
  );
}

/* ------------------------------------------------------------------ */
/* events（SSE 事件的持久化副本 → /runs 回放的唯一数据源）               */
/* ------------------------------------------------------------------ */

export function appendEvent(db: DatabaseSync, runId: string, event: CaliberEvent): void {
  const last = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE run_id = ?")
    .get(runId) as { n: number };
  db.prepare("INSERT INTO events (run_id, seq, type, payload) VALUES (?, ?, ?, ?)").run(
    runId,
    last.n + 1,
    event.type,
    JSON.stringify(event),
  );
}

export function getEventsForRun(db: DatabaseSync, runId: string): CaliberEvent[] {
  const rows = db
    .prepare("SELECT payload FROM events WHERE run_id = ? ORDER BY seq")
    .all(runId) as Array<{ payload: string }>;
  return rows.map((r) => JSON.parse(r.payload) as CaliberEvent);
}

/* ------------------------------------------------------------------ */
/* reports / corrections（第 5 周接入，当天最小闭环先留好）              */
/* ------------------------------------------------------------------ */

export function saveReport(
  db: DatabaseSync,
  input: { id: string; name: string; sql: string; chartSpec: unknown; sourceRunId?: string; createdAt: string },
): void {
  db.prepare(
    "INSERT INTO reports (id, name, sql, chart_spec, source_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(input.id, input.name, input.sql, JSON.stringify(input.chartSpec ?? null), input.sourceRunId ?? null, input.createdAt);
}

export function saveCorrection(
  db: DatabaseSync,
  input: { id: string; question: string; sql: string; tables: string[]; keywords: string[]; createdAt: string },
): void {
  db.prepare(
    `INSERT INTO corrections (id, question, sql, tables, keywords, enabled, verified_by_user, created_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?)`,
  ).run(
    input.id,
    input.question,
    input.sql,
    JSON.stringify(input.tables),
    JSON.stringify(input.keywords),
    input.createdAt,
  );
}