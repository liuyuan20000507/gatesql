/**
 * explain.ts 与 executor.ts 的验收测试。
 */

import { describe, expect, it } from "vitest";

import { explainCost } from "@/lib/sql/explain";
import { SqlExecutor, QueryTimeoutError } from "@/lib/sql/executor";

const SHOP_DB = "data/shop.db";

describe("explainCost：代价预检", () => {
  it("三表笛卡尔积被拦截（无任何走索引的 SEARCH）", () => {
    const verdict = explainCost("SELECT COUNT(*) FROM orders, order_items, customers", SHOP_DB);
    expect(verdict.ok).toBe(false);
  });

  it("正常 JOIN（走主键 SEARCH）放行", () => {
    const verdict = explainCost(
      "SELECT o.status, COUNT(*) FROM orders o JOIN order_items oi ON oi.order_id = o.id GROUP BY o.status",
      SHOP_DB,
    );
    expect(verdict.ok).toBe(true);
  });

  it("单表全量查询（products 30 行）放行", () => {
    const verdict = explainCost("SELECT * FROM products", SHOP_DB);
    expect(verdict.ok).toBe(true);
  });

  it("单表全量 COUNT（order_items）放行", () => {
    const verdict = explainCost("SELECT COUNT(*) FROM order_items", SHOP_DB);
    expect(verdict.ok).toBe(true);
  });
});

describe("SqlExecutor：worker 执行", () => {
  it("执行合法查询并返回列与行", async () => {
    const ex = new SqlExecutor(SHOP_DB, 5000);
    try {
      const result = await ex.execute("SELECT id, name FROM products LIMIT 3");
      expect(result.columns).toEqual(["id", "name"]);
      expect(result.rows).toHaveLength(3);
    } finally {
      ex.close();
    }
  });

  it("执行报错（未知列）会抛出，且 worker 可复用", async () => {
    const ex = new SqlExecutor(SHOP_DB, 5000);
    try {
      await expect(ex.execute("SELECT no_such_col FROM products")).rejects.toThrow();
      // 报错后 worker 仍可继续执行（错误结果不污染 worker 状态之外的连接）
      const ok = await ex.execute("SELECT COUNT(*) AS n FROM orders");
      expect(ok.rows[0][0]).toBe(12000);
    } finally {
      ex.close();
    }
  });

  it("超时会被放弃等待并抛 QueryTimeoutError", async () => {
    // 用一个真正慢的查询：三表笛卡尔积（explain 会拦，但绕开预检直接喂执行器）
    const ex = new SqlExecutor(SHOP_DB, 200);
    try {
      await expect(
        ex.execute("SELECT COUNT(*) FROM orders, order_items, customers"),
      ).rejects.toBeInstanceOf(QueryTimeoutError);
    } finally {
      ex.close();
    }
  });
});