import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { checkColumnReferences, listTableColumns } from "@/lib/sql/schema-check";

const dbFiles: string[] = [];

afterEach(() => {
  dbFiles.splice(0).forEach((f) => rmSync(f, { force: true }));
});

function makeDb(): string {
  const dir = path.join("data", "test-app");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `schema_check_${crypto.randomUUID()}.db`);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT, created_at TEXT, customer_id INTEGER, channel TEXT);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, quantity INTEGER, unit_price REAL, amount REAL);
  `);
  db.close();
  dbFiles.push(file);
  return file;
}

describe("listTableColumns", () => {
  it("读真实表列清单，跳过 sqlite_ 内部表", () => {
    const map = listTableColumns(makeDb());
    expect([...map.keys()].sort()).toEqual(["order_items", "orders"]);
    expect(map.get("orders")!.has("created_at")).toBe(true);
    expect(map.get("order_items")!.has("amt")).toBe(false);
  });
});

describe("checkColumnReferences（零误报纪律）", () => {
  const schema = () => listTableColumns(makeDb());

  it("正确带前缀引用 → ok", () => {
    const r = checkColumnReferences(
      "SELECT o.status, oi.amount FROM orders o JOIN order_items oi ON o.id = oi.order_id",
      schema(),
    );
    expect(r.ok).toBe(true);
  });

  it("带前缀的错列 → fail，诊断含该表可用列", () => {
    const r = checkColumnReferences("SELECT oi.amt FROM order_items oi", schema());
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("表 order_items 不存在列 amt");
    expect(r.detail).toContain("amount");
  });

  it("表达式内嵌套的错列也能核对（substr 参数）", () => {
    const r = checkColumnReferences("SELECT substr(o.created_, 1, 7) FROM orders o", schema());
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("created_");
  });

  it("无前缀列 → 跳过（多表歧义不猜）", () => {
    expect(checkColumnReferences("SELECT amount FROM order_items", schema()).ok).toBe(true);
  });

  it("CTE/子查询别名前缀 → 跳过（不是真实表）", () => {
    const r = checkColumnReferences(
      "WITH t AS (SELECT id FROM orders) SELECT t.not_a_real_column FROM t",
      schema(),
    );
    expect(r.ok).toBe(true);
  });

  it("COUNT(*) 星号 → ok", () => {
    expect(checkColumnReferences("SELECT COUNT(*) FROM orders", schema()).ok).toBe(true);
  });

  it("解析失败 → fail-open 放行", () => {
    expect(checkColumnReferences("这不是 SQL", schema()).ok).toBe(true);
  });
});
