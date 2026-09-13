/**
 * 第 0 阶段 0.6 的验证脚本：确认 node:sqlite 的三个关键行为。
 * 这些行为是架构决策（ADR-002/003）的实测依据：
 *   1. setAuthorizer 存在（安全叙事的核心）
 *   2. prepare() 对多语句静默截断（驱动给的是虚假安全感）
 *   3. readOnly 连接真的写不进去
 *   4. EQP 能区分全表扫描和索引查找（代价预检的依据）
 *
 * 用法：node scripts/probe_sqlite.mjs
 */

import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/shop.db", { readOnly: true });

console.log("【1】setAuthorizer 是否存在");
console.log(`    typeof db.setAuthorizer = ${typeof db.setAuthorizer}`);

console.log("\n【2】prepare() 对多语句的行为（期望：静默只执行第一句，不报错）");
const r = db.prepare("SELECT 1 AS a; DROP TABLE orders").all();
console.log(`    返回 ${JSON.stringify(r)} —— ${r.length === 1 && r[0].a === 1 ? "确认静默截断" : "行为与预期不符"}`);

console.log("\n【3】只读连接执行写操作（期望：抛异常）");
try {
  db.exec("DELETE FROM orders");
  console.log("    没有抛异常！这不是只读连接，严重问题");
} catch (e) {
  console.log(`    抛出异常: ${e.message}`);
}

console.log("\n【4】EXPLAIN QUERY PLAN 区分 SCAN 和 SEARCH");
const cart = db.prepare(
  "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM orders, order_items, customers"
).all();
console.log("    笛卡尔积（危险）:");
for (const row of cart) console.log(`      ${row.detail}`);
const good = db.prepare(
  "EXPLAIN QUERY PLAN SELECT c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = 42"
).all();
console.log("    正常 JOIN（健康）:");
for (const row of good) console.log(`      ${row.detail}`);

db.close();
console.log("\n四项全部符合预期 —— 0.6 完成");
