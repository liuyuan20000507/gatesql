/**
 * EQP 代价预检：执行前用 EXPLAIN QUERY PLAN 拦截「缺失连接条件的笛卡尔积」。
 *
 * 这类查询既不是语法错误（数据库不报错）、也不触发任何安全规则、
 * 重试机制也救不了它——只会安静地把服务打死（node:sqlite 是同步 API，
 * 一条慢查询会冻住整个事件循环）。只能预防，见 docs/07-security.md 第 6 层。
 *
 * 判据（结合行数量级，见 guard 探针的实测）：
 *   - 正常 JOIN 的 EQP 输出含 SEARCH（走索引）
 *   - 三表笛卡尔积输出三行全 SCAN（实测 "SCAN orders USING COVERING INDEX"）
 *   - 单表单表全扫描合法（order_items 全量 COUNT 也是 SCAN）
 *   所以规则是：≥2 张表出现 SCAN 且全程无 SEARCH → 拒绝；否则放行。
 */

import { openReadOnlyConnection } from "@/lib/sql/guard";

export type ExplainVerdict =
  | { ok: true }
  | { ok: false; reason: string };

export function explainCost(querySql: string, dbPath: string): ExplainVerdict {
  const db = openReadOnlyConnection(dbPath);
  let rows: Array<{ detail: string }>;
  try {
    rows = db.prepare("EXPLAIN QUERY PLAN " + querySql).all() as unknown as Array<{ detail: string }>;
  } catch (err) {
    // 预检失败即拒绝（fail-closed；EQP 通过不代表能跑，只是预防慢查询）
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `代价预检失败: ${msg.slice(0, 120)}` };
  } finally {
    // 连接由调用方创建会更好；这里是换一个轻量的、用完即关的临时连接
    // （真实 executor 场景由 worker 持有连接，不在此处开连接）
    db.close();
  }

  const scanned = new Set<string>();
  let anySearch = false;
  for (const row of rows) {
    const detail = row.detail ?? "";
    const scan = /^SCAN\s+(\S+)/.exec(detail);
    if (scan) scanned.add(scan[1]);
    if (/^SEARCH/.test(detail)) anySearch = true;
  }

  if (scanned.size >= 2 && !anySearch) {
    return {
      ok: false,
      reason: `检测到 ${scanned.size} 张表全表扫描且无任何走索引的连接（疑似缺失 JOIN 条件），已预检拦截`,
    };
  }
  return { ok: true };
}