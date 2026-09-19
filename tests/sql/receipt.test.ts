import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import { Parser } from "node-sql-parser";

import { afterEach, describe, expect, it } from "vitest";

import { buildReceipt, sqlPinsCompletedAst } from "@/lib/sql/receipt";

const dbFiles: string[] = [];

afterEach(() => {
  dbFiles.splice(0).forEach((f) => rmSync(f, { force: true }));
});

/** 最小 shop.db：orders(status, created_at) + order_items(amount)
 *  明细金额：已完成 3 单各 100/200/300（合计 600）；已取消 5 单挂 250；已退款 2 单挂 80；全部明细合计 930 */
function makeShopDb(): string {
  const dir = path.join("data", "test-app");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `receipt_test_${crypto.randomUUID()}.db`);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT, created_at TEXT);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, amount REAL, unit_price REAL);
  `);
  const insOrder = db.prepare("INSERT INTO orders (id, status, created_at) VALUES (?, ?, ?)");
  const insItem = db.prepare("INSERT INTO order_items (id, order_id, amount, unit_price) VALUES (?, ?, ?, ?)");
  // 已完成 3（其中 2 单在 2026-08），已取消 5（1 单在 2026-08），已退款 2
  insOrder.run(1, "已完成", "2026-08-10");
  insOrder.run(2, "已完成", "2026-08-20");
  insOrder.run(3, "已完成", "2026-07-01");
  insOrder.run(4, "已取消", "2026-08-15");
  for (let i = 0; i < 4; i++) insOrder.run(5 + i, "已取消", "2026-05-01");
  insOrder.run(9, "已退款", "2026-06-01");
  insOrder.run(10, "已退款", "2026-06-02");
  insItem.run(1, 1, 100, 100);
  insItem.run(2, 2, 200, 200);
  insItem.run(3, 3, 300, 300);
  for (let i = 0; i < 5; i++) insItem.run(4 + i, 4, 50, 50);
  insItem.run(9, 9, 40, 40);
  insItem.run(10, 10, 40, 40);
  db.close();
  dbFiles.push(file);
  return file;
}

const AMOUNT_SQL = "SELECT SUM(oi.amount) AS total FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = '已完成'";

describe("buildReceipt（5C：AST 识别 + 实际 COUNT）", () => {
  it("金额 SQL 带已完成过滤 → 排除计数来自真实库（全库）", () => {
    const r = buildReceipt({ sql: AMOUNT_SQL, resolution: null, asOf: "2026-08-31", shopDbPath: makeShopDb() });
    expect(r.filters).toEqual(["订单状态=已完成"]);
    expect(r.excluded).toEqual([
      { status: "已取消", count: 5 },
      { status: "已退款", count: 2 },
    ]);
    expect(r.fullyTranslated).toBe(true);
  });

  it("带时间范围 → 排除计数收窄到范围内", () => {
    const r = buildReceipt({
      sql: AMOUNT_SQL,
      resolution: { from: "2026-08-01", to: "2026-08-31" },
      asOf: "2026-08-31",
      shopDbPath: makeShopDb(),
    });
    expect(r.scope).toBe("2026-08-01 至 2026-08-31");
    expect(r.excluded).toEqual([{ status: "已取消", count: 1 }]);
  });

  it("纯计数查询 → 无口径声明义务，fullyTranslated true（6B 实测误伤修复）", () => {
    const r = buildReceipt({
      sql: "SELECT COUNT(DISTINCT customer_id) AS n FROM orders",
      resolution: null,
      asOf: "2026-08-31",
      shopDbPath: makeShopDb(),
    });
    expect(r.filters).toEqual([]);
    expect(r.excluded).toEqual([]);
    expect(r.fullyTranslated).toBe(true);
    // 卡片的 method 不得对非金额查询谎称「按成交小计汇总」
    expect(r.method).toBe("按查询结果直接统计");
  });

  it("金额聚合但无状态约束 → 有义务却说明不了，如实 false", () => {
    const r = buildReceipt({
      sql: "SELECT SUM(amount) AS total FROM order_items",
      resolution: null,
      asOf: "2026-08-31",
      shopDbPath: makeShopDb(),
    });
    expect(r.fullyTranslated).toBe(false);
  });

  it("无法解析的 SQL → 如实落 false，绝不猜数", () => {
    const r = buildReceipt({ sql: "这不是 SQL", resolution: null, asOf: "2026-08-31", shopDbPath: makeShopDb() });
    expect(r.fullyTranslated).toBe(false);
    expect(r.excluded).toEqual([]);
  });

  it("shopDbPath 为 null → 跳过 COUNT（不炸、不猜数）", () => {
    const r = buildReceipt({ sql: AMOUNT_SQL, resolution: null, asOf: "2026-08-31", shopDbPath: null });
    expect(r.excluded).toEqual([]);
    expect(r.fullyTranslated).toBe(false);
  });

  it("unit_price 引用 → 计价口径亮明；排除金额合计 = 控制总数 − 结果值", () => {
    const r = buildReceipt({
      sql: "SELECT SUM(oi.unit_price) AS v FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = '已完成'",
      resolution: null,
      asOf: "2026-08-31",
      shopDbPath: makeShopDb(),
      resultValue: 600,
    });
    expect(r.unitPriceUsed).toBe(true);
    // 控制查询剥掉 status、保留时间（无）→ 全部明细 930；排除金额 = 930 − 600 = 330
    expect(r.excludedMoneyTotal).toBe(330);
  });

  it("未传 resultValue → 排除金额合计为 null（绝不猜）", () => {
    const r = buildReceipt({ sql: AMOUNT_SQL, resolution: null, asOf: "2026-08-31", shopDbPath: makeShopDb() });
    expect(r.excludedMoneyTotal).toBeNull();
  });

  it("单日 resolution → scope 只显示当天；范围越过水位 → outOfWatermark 标记", () => {
    const r = buildReceipt({
      sql: AMOUNT_SQL,
      resolution: { from: "2026-08-05", to: "2026-08-05" },
      asOf: "2026-08-31",
      shopDbPath: makeShopDb(),
    });
    expect(r.scope).toBe("2026-08-05");
    expect(r.outOfWatermark).toBe(false);

    const beyond = buildReceipt({
      sql: AMOUNT_SQL,
      resolution: { from: "2026-08-01", to: "2027-01-31" },
      asOf: "2026-08-31",
      shopDbPath: makeShopDb(),
    });
    expect(beyond.scope).toBe("2026-08-01 至 2027-01-31");
    expect(beyond.outOfWatermark).toBe(true);
  });
});

describe("sqlPinsCompletedAst", () => {
  const parse = (sql: string): unknown => new Parser().astify(sql, { databaseType: "sqlite" } as never);

  it("普通 WHERE 命中", () => {
    expect(sqlPinsCompletedAst(parse(AMOUNT_SQL))).toBe(true);
  });

  it("括号包裹 / 别名前缀命中", () => {
    expect(sqlPinsCompletedAst(parse("SELECT 1 FROM orders WHERE (o.status = '已完成')"))).toBe(true);
  });

  it("其他状态值不算钉住", () => {
    expect(sqlPinsCompletedAst(parse("SELECT 1 FROM orders WHERE status = '已取消'"))).toBe(false);
  });
});
