/**
 * few-shot 检索的单测：确定性排序、阈值门控、宁缺毋滥（docs/05 第四节）。
 */

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatFewshotExamples, retrieveFewshots } from "@/lib/agent/fewshot";
import { openAppDb, saveCorrection } from "@/lib/db/app";

const openConns: ReturnType<typeof openAppDb>[] = [];
const files: string[] = [];

function freshDb() {
  const dir = path.join("data", "test-app");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `fewshot_test_${crypto.randomUUID()}.db`);
  const db = openAppDb(file);
  openConns.push(db);
  files.push(file);
  return db;
}

afterEach(() => {
  openConns.forEach((c) => {
    try {
      c.close();
    } catch {
      /* 已关闭 */
    }
  });
  openConns.length = 0;
  files.splice(0).forEach((f) => rmSync(f, { force: true }));
});

function addVerified(db: ReturnType<typeof openAppDb>, id: string, question: string, tables: string[]) {
  saveCorrection(db, { id, question, sql: `SELECT 1 -- ${id}`, tables, keywords: [], createdAt: "2026-09-15T00:00:00.000Z" });
  db.prepare("UPDATE corrections SET verified_by_user = 1 WHERE id = ?").run(id);
}

describe("retrieveFewshots", () => {
  it("库内没有样本 → 空数组（宁缺毋滥）", () => {
    const db = freshDb();
    expect(retrieveFewshots(db, "各分类销售额", ["orders", "order_items"])).toEqual([]);
  });

  it("相似度低于阈值 → 不给（表和用词都不搭的样本被拒）", () => {
    const db = freshDb();
    addVerified(db, "fs_a", "今天天气怎么样", ["weather"]);
    const r = retrieveFewshots(db, "近 30 天的已完成订单数", ["orders"]);
    expect(r).toEqual([]);
  });

  it("表重叠 + 词重叠达标 → 命中，且上限 2 条、平分按 id 字典序", () => {
    const db = freshDb();
    addVerified(db, "fs_z", "已完成订单的总数量是多少", ["orders"]);
    addVerified(db, "fs_b", "已完成订单一共有多少笔", ["orders"]);
    addVerified(db, "fs_c", "已完成订单的笔数统计", ["orders"]);
    addVerified(db, "fs_d", "已完成订单数量按渠道看", ["orders"]);
    const r = retrieveFewshots(db, "已完成订单有多少", ["orders"]);
    expect(r.length).toBe(2);
    expect(r.map((x) => x.id).sort()).toEqual(r.map((x) => x.id)); // id 升序（平分裁决确定性）
  });

  it("未验证样本（verified_by_user=0）永远不进 prompt（防脏样本污染）", () => {
    const db = freshDb();
    saveCorrection(db, { id: "fs_unverified", question: "已完成订单有多少", sql: "SELECT 1", tables: ["orders"], keywords: [], createdAt: "x" });
    expect(retrieveFewshots(db, "已完成订单有多少", ["orders"])).toEqual([]);
  });
});

describe("formatFewshotExamples", () => {
  it("空样本 → 空串（保证 OFF 路径 prompt 逐字节不变）", () => {
    expect(formatFewshotExamples([])).toBe("");
  });
});
