/**
 * app.db 访问层验收测试（使用临时数据库文件，不碰 data/app.db）。
 */

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, afterEach } from "vitest";

import {
  appendEvent,
  createRun,
  finishRun,
  getEventsForRun,
  getStepsForRun,
  insertStep,
  listRuns,
  openAppDb,
  saveCorrection,
  saveReport,
} from "@/lib/db/app";
import type { CaliberEvent } from "@/lib/events";

const dbFiles: string[] = [];
const openConns: ReturnType<typeof openAppDb>[] = [];

function freshDb() {
  // 不用 os.tmpdir()：这台机器 TEMP 路径带用户名的 GBK 乱码，SQLite 建不了文件。
  // 放项目 data/test-app/ 下（data/*.db 已被 gitignore），纯 ASCII 路径。
  const dir = path.join("data", "test-app");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `caliber_test_${crypto.randomUUID()}.db`);
  const db = openAppDb(file);
  dbFiles.push(file);
  openConns.push(db);
  return { file, db };
}

afterEach(() => {
  // 先关连接，否则 Windows 上文件被锁，rmSync 会 EPERM
  openConns.forEach((c) => {
    try {
      c.close();
    } catch {
      // 已被显式 close 过
    }
  });
  openConns.length = 0;
  dbFiles.splice(0).forEach((f) => rmSync(f, { force: true }));
});

describe("app.db：结构", () => {
  it("一次性建出全部表", () => {
    const { db } = freshDb();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables.sort()).toEqual(
      ["corrections", "eval_items", "eval_runs", "events", "reports", "runs", "steps"].sort(),
    );
  });
});

describe("app.db：run + step + event 闭环", () => {
  it("createRun → finishRun 后字段落库", () => {
    const { db } = freshDb();
    createRun(db, { id: "r_1", question: "总销售额", asOfDate: "2026-08-31", llmMode: "replay", createdAt: "2026-09-13T00:00:00.000Z" });
    finishRun(db, {
      id: "r_1",
      verdict: "verified",
      verdictReasons: [],
      finalStatus: "ok",
      attempts: 1,
      llmCalls: 2,
      inputTokens: 100,
      outputTokens: 50,
      elapsedMs: 1234,
    });
    const runs = listRuns(db);
    expect(runs[0].verdict).toBe("verified");
    expect(runs[0].elapsed_ms).toBe(1234);
  });

  it("step 保留异质 attributes（llm_call 存 prompt 全文）", () => {
    const { db } = freshDb();
    createRun(db, { id: "r_2", question: "q", asOfDate: "2026-08-31", llmMode: "live", createdAt: "2026-09-13T00:00:00.000Z" });
    insertStep(db, {
      runId: "r_2",
      seq: 1,
      kind: "llm_call",
      startedAt: 1000,
      endedAt: 2000,
      status: "ok",
      attributes: { prompt: "完整 prompt 原文", completion: "回复", model: "ark-code-latest", inputTokens: 5, outputTokens: 2 },
    });
    const rows = db.prepare("SELECT * FROM steps WHERE run_id = ?").all("r_2") as Array<{ attributes: string }>;
    const attrs = JSON.parse(rows[0].attributes);
    expect(attrs.prompt).toBe("完整 prompt 原文");
  });

  it("getStepsForRun：按 seq 升序 + attributes 解析 + 耗时计算（4G 追踪面板数据源）", () => {
    const { db } = freshDb();
    createRun(db, { id: "r_9", question: "q", asOfDate: "2026-08-31", llmMode: "replay", createdAt: "2026-09-15T00:00:00.000Z" });
    insertStep(db, { runId: "r_9", seq: 2, kind: "lint", startedAt: 500, endedAt: 520, status: "ok", attributes: { violations: [{ ruleId: "R1", level: "block", missingPredicate: "x", suggestion: "y" }] } });
    insertStep(db, { runId: "r_9", seq: 1, kind: "guard", startedAt: 100, status: "failed", attributes: { detail: "多语句" } });
    const steps = getStepsForRun(db, "r_9");
    expect(steps.map((s) => s.seq)).toEqual([1, 2]); // seq 升序
    expect(steps[0].durationMs).toBeNull(); // 只有 startedAt
    expect(steps[1].durationMs).toBe(20);
    expect((steps[1].attributes.violations as Array<{ ruleId: string }>)[0].ruleId).toBe("R1");
    expect(getStepsForRun(db, "r_nobody")).toEqual([]); // 评测 run 无 events 但有 steps 的对称面：无记录时为空
  });

  it("事件回放 roundtrip：原样还原 CaliberEvent", () => {
    const { db } = freshDb();
    createRun(db, { id: "r_3", question: "q", asOfDate: "2026-08-31", llmMode: "replay", createdAt: "2026-09-13T00:00:00.000Z" });
    const event: CaliberEvent = {
      type: "rows",
      columns: ["category"],
      rows: [["手机数码", 123.45]],
      rowCount: 1,
      truncated: false,
      elapsedMs: 3,
    };
    appendEvent(db, "r_3", event);
    expect(getEventsForRun(db, "r_3")).toEqual([event]);
  });

  it("reports / corrections 可写可读", () => {
    const { db } = freshDb();
    saveReport(db, { id: "rep_1", name: "月度销售趋势", sql: "SELECT 1", chartSpec: { kind: "line" }, sourceRunId: "r_1", createdAt: "2026-09-13T00:00:00.000Z" });
    saveCorrection(db, { id: "corr_1", question: "月销售额", sql: "SELECT ...", tables: ["orders"], keywords: ["销售额", "月度"], createdAt: "2026-09-13T00:00:00.000Z" });

    const rep = db.prepare("SELECT name, chart_spec FROM reports WHERE id = ?").get("rep_1") as { name: string; chart_spec: string };
    expect(rep.name).toBe("月度销售趋势");
    expect(JSON.parse(rep.chart_spec)).toEqual({ kind: "line" });

    const corr = db.prepare("SELECT enabled, verified_by_user FROM corrections WHERE id = ?").get("corr_1") as { enabled: number; verified_by_user: number };
    expect(corr.enabled).toBe(1);
    expect(corr.verified_by_user).toBe(0); // 默认未人工确认，入库前必须显式置 1
  });
});