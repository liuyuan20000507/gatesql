/**
 * guard.ts 的验收测试：30 条攻击语料 + 只读连接行为。
 *
 * 当前状态：RED（guard.ts 是未实现桩）。作者实现 guard.ts 后本文件应全绿。
 * 失败信息会精确告诉你「哪条攻击没被拦住」。
 */

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

import { guardSql, openReadOnlyConnection } from "@/lib/sql/guard";

const SHOP_DB = "data/shop.db";

interface AttackCase {
  name: string;
  sql: string;
  /** "reject" 表示必须被拦下；"allow" 表示必须放行（false-positive 防护） */
  expect: "reject" | "allow";
}

/**
 * 攻击语料。前 29 条来自 docs/07-security.md 的自测清单，
 * 最后 1 条是「字符串字面量误杀」反例 —— 把 SELECT 'drop table' 也拦下的
 * guard 说明你在用关键字匹配，那是最弱的方案。
 */
const ATTACK_CASES: AttackCase[] = [
  // —— 多语句 / 注释拆词 / 大小写 / 全角 ——
  { name: "分号多语句", sql: "SELECT 1; DROP TABLE orders", expect: "reject" },
  { name: "注释拆词-分号", sql: "SELECT/**/1;/**/DROP/**/TABLE/**/orders", expect: "reject" },
  { name: "大小写混写", sql: "sElEcT 1; dRoP tAbLe orders", expect: "reject" },
  { name: "全角分号", sql: "SELECT 1；DELETE FROM orders", expect: "reject" },
  // —— CTE / 子查询藏写操作 ——
  { name: "CTE 藏写操作", sql: "WITH x AS (DELETE FROM orders RETURNING 1) SELECT * FROM x", expect: "reject" },
  { name: "子查询藏写操作-嵌套", sql: "SELECT (SELECT 1 FROM (DELETE FROM orders))", expect: "reject" },
  { name: "UNION 拼接读系统表", sql: "SELECT 1 UNION SELECT * FROM sqlite_master", expect: "reject" },
  // —— PRAGMA / ATTACH ——
  { name: "PRAGMA 改可写模式", sql: "PRAGMA writable_schema=1", expect: "reject" },
  { name: "PRAGMA 读配置", sql: "PRAGMA journal_mode", expect: "reject" },
  { name: "ATTACH 挂载外部库", sql: "ATTACH DATABASE '/tmp/evil.db' AS evil", expect: "reject" },
  // —— 系统表 / 注释表 ——
  { name: "直接读 sqlite_master", sql: "SELECT * FROM sqlite_master", expect: "reject" },
  { name: "读 _column_comments 表", sql: "SELECT * FROM _column_comments", expect: "reject" },
  // —— 写操作直白形态（即使语义无效也必须被结构拒绝）——
  { name: "DELETE 直白", sql: "DELETE FROM orders", expect: "reject" },
  { name: "UPDATE 直白", sql: "UPDATE orders SET status='已退款'", expect: "reject" },
  { name: "INSERT 直白", sql: "INSERT INTO orders VALUES (1,2,'2026-01-01','已完成','APP')", expect: "reject" },
  { name: "DROP 直白", sql: "DROP TABLE orders", expect: "reject" },
  // —— 非法但需拒绝的形态 ——
  { name: "非 SELECT 开头", sql: "EXPLAIN SELECT * FROM orders", expect: "reject" },
  { name: "VACUUM", sql: "VACUUM", expect: "reject" },
  { name: "复制表结构写库", sql: "CREATE TABLE x AS SELECT * FROM orders", expect: "reject" },
  { name: "ALTER 加列", sql: "ALTER TABLE orders ADD COLUMN xx TEXT", expect: "reject" },
  // —— 合法但危险的资源类（靠 LIMIT 收紧兜底，但结构上不含写操作）——
  { name: "无 LIMIT 全表拉取", sql: "SELECT * FROM order_items", expect: "allow" },
  { name: "超大 LIMIT", sql: "SELECT * FROM order_items LIMIT 999999", expect: "allow" },
  // —— 有争议但必须放行的形态（false-positive 防护）——
  { name: "字符串字面量含危险词", sql: "SELECT 'drop table' AS x", expect: "allow" },
  { name: "注释里的危险词", sql: "SELECT 1 /* drop table orders */", expect: "allow" },
  { name: "字符串含分号", sql: "SELECT 'a;b' AS x", expect: "allow" },
  { name: "CTE 纯读", sql: "WITH x AS (SELECT id FROM orders WHERE status='已完成') SELECT COUNT(*) FROM x", expect: "allow" },
  { name: "窗口函数", sql: "SELECT id, RANK() OVER (ORDER BY amount DESC) FROM order_items", expect: "allow" },
  { name: "子查询比较", sql: "SELECT name FROM products WHERE price > (SELECT AVG(price) FROM products)", expect: "allow" },
  { name: "合法 JOIN+WHERE 过滤", sql: "SELECT o.channel, COUNT(DISTINCT o.id) FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.status='已完成' GROUP BY o.channel", expect: "allow" },
  { name: "COALESCE 处理可空列", sql: "SELECT COALESCE(region,'未知') FROM customers GROUP BY region", expect: "allow" },
];

describe("guardSql：30 条攻击语料", () => {
  for (const c of ATTACK_CASES) {
    it(`${c.expect === "reject" ? "拦下" : "放行"} — ${c.name}`, () => {
      const verdict = guardSql(c.sql);
      if (c.expect === "allow") {
        expect(verdict.ok, `本应放行却被拦下：${c.sql}`).toBe(true);
      } else {
        expect(verdict.ok, `本应拦下却放行了：${c.sql}`).toBe(false);
      }
    });
  }
});

describe("guardSql 的附加约定", () => {
  it("放行的 SQL 应带有被收紧的 LIMIT（无 LIMIT 时应注入 ≤1000）", () => {
    const verdict = guardSql("SELECT * FROM orders");
    if (verdict.ok) {
      const limitMatch = /LIMIT\s+(\d+)/i.exec(verdict.sql);
      expect(limitMatch).not.toBeNull();
      expect(Number(limitMatch![1])).toBeLessThanOrEqual(1000);
    }
    const big = guardSql("SELECT * FROM orders LIMIT 999999");
    if (big.ok) {
      const limitMatch = /LIMIT\s+(\d+)/i.exec(big.sql);
      expect(limitMatch).not.toBeNull();
      expect(Number(limitMatch![1])).toBeLessThanOrEqual(1000);
    }
  });

  it("拒绝时应给出 detail（人类可读）", () => {
    const v = guardSql("SELECT 1; DROP TABLE orders");
    if ("detail" in v && v.detail) {
      expect(v.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("openReadOnlyConnection：连接层 + authorizer", () => {
  function freshConnection() {
    const db = openReadOnlyConnection(SHOP_DB);
    expect(db).toBeInstanceOf(DatabaseSync);
    return db;
  }

  it("只读连接拒绝一切写语句", () => {
    const db = freshConnection();
    expect(() => db.exec("DELETE FROM orders")).toThrow(/readonly/i);
  });

  it("authorizer 拒绝非白名单表的读取（sqlite_master / _column_comments）", () => {
    const db = freshConnection();
    // authorizer 在 prepare 阶段生效
    expect(() => db.prepare("SELECT * FROM sqlite_master")).toThrow();
    expect(() => db.prepare("SELECT * FROM _column_comments")).toThrow();
  });

  it("authorizer 放行业务表的正常 SELECT", () => {
    const db = freshConnection();
    const rows = db.prepare("SELECT COUNT(*) AS n FROM orders").all();
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 12000 });
  });

  it("authorizer 拒绝 CTE 里暗藏的写操作", () => {
    const db = freshConnection();
    expect(() =>
      db.prepare("WITH x AS (DELETE FROM orders RETURNING 1) SELECT * FROM x"),
    ).toThrow();
  });

  it("authorizer 拒绝 PRAGMA / ATTACH 类动作", () => {
    const db = freshConnection();
    expect(() => db.prepare("PRAGMA journal_mode")).toThrow();
    expect(() => db.prepare("ATTACH DATABASE 'x' AS evil")).toThrow();
  });
});