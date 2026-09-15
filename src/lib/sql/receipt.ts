/**
 * 口径回执（5C，docs/08）：从最后执行 SQL 的 AST 识别口径谓词形态，
 * 并去 shop.db 实际 COUNT 被排除的订单 —— 卡片上的每个数字都来自代码，
 * 模型碰不到它（03-api-contract.md 的兑现：「已排除已取消 1873 单」）。
 *
 * 策略：解析失败 / 数据库不可用 → 如实落 fullyTranslated=false，
 * 绝不猜一个数字填上去。
 */

import { DatabaseSync } from "node:sqlite";

import { Parser } from "node-sql-parser";

export interface ReceiptExcluded {
  status: string;
  count: number;
}

export interface ReceiptPayload {
  scope: string;
  filters: string[];
  method: string;
  dataUntil: string;
  coverage: string;
  fullyTranslated: boolean;
  excluded: ReceiptExcluded[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * AST 里是否存在 status='已完成' 的等值谓词（含括号包裹、左右交换两种形态）。
 * 判定方式：binary_expr(=) 的两侧，一侧序列化后含列名 status，另一侧含字面值 已完成。
 */
export function sqlPinsCompletedAst(ast: unknown): boolean {
  const seen: unknown[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isRecord(node)) return;
    seen.push(node);
    Object.values(node).forEach(walk);
  };
  walk(ast);
  for (const node of seen) {
    if (!isRecord(node) || node.type !== "binary_expr" || node.operator !== "=") continue;
    const l = JSON.stringify(node.left ?? "");
    const r = JSON.stringify(node.right ?? "");
    const pin =
      (l.includes('"status"') && r.includes("已完成")) ||
      (r.includes('"status"') && l.includes("已完成"));
    if (pin) return true;
  }
  return false;
}

/**
 * 构建回执。shopDbPath 为 null（或库不可用）时跳过 COUNT，绝不猜数。
 */
export function buildReceipt(input: {
  sql: string | null;
  resolution: { from: string; to: string } | null;
  asOf: string;
  shopDbPath: string | null;
}): ReceiptPayload {
  const base = {
    scope: input.resolution ? `${input.resolution.from} 至 ${input.resolution.to}` : "全时段",
    filters: [] as string[],
    method: "按明细行成交小计汇总",
    dataUntil: input.asOf,
    coverage: "见结果表格",
    excluded: [] as ReceiptExcluded[],
  };

  if (input.sql === null) return { ...base, fullyTranslated: input.resolution !== null };

  let pinned = false;
  try {
    const ast = new Parser().astify(input.sql, {
      // 与 lint.ts 同款断言：上游类型声明与运行时实参不一致（第 2 周实测）
      databaseType: "sqlite",
    } as never);
    pinned = sqlPinsCompletedAst(ast);
  } catch {
    return { ...base, fullyTranslated: false };
  }
  if (!pinned) return { ...base, fullyTranslated: input.resolution !== null };

  base.filters = ["订单状态=已完成"];
  let countsOk = false;
  if (input.shopDbPath !== null) {
    try {
      const db = new DatabaseSync(input.shopDbPath, { readOnly: true });
      try {
        const rows = input.resolution
          ? db
              .prepare(
                "SELECT status, COUNT(*) AS n FROM orders WHERE status <> ? AND created_at >= ? AND created_at <= ? GROUP BY status ORDER BY status",
              )
              .all("已完成", input.resolution.from, input.resolution.to)
          : db
              .prepare("SELECT status, COUNT(*) AS n FROM orders WHERE status <> ? GROUP BY status ORDER BY status")
              .all("已完成");
        for (const r of rows as Array<{ status: string; n: number }>) {
          base.excluded.push({ status: r.status, count: Number(r.n) });
        }
        countsOk = true;
      } finally {
        db.close();
      }
    } catch {
      countsOk = false;
    }
  }
  return { ...base, fullyTranslated: countsOk || input.resolution !== null };
}
