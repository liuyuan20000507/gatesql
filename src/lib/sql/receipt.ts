/**
 * 口径回执（5C，docs/08）：从最后执行 SQL 的 AST 识别口径谓词形态，
 * 并去 shop.db 实际 COUNT 被排除的订单 —— 卡片上的每个数字都来自代码，
 * 模型碰不到它（03-api-contract.md 的兑现：「已排除已取消 1873 单」）。
 *
 * fullyTranslated 的语义：**有义务说明的口径是否都说明白了**。
 * 义务边界与 lint 的 R1 触发条件对齐（AST 含 SUM/AVG 金额聚合）——
 * 纯计数等无金额聚合的查询本就没有口径声明义务，不算翻译不全（6B 实测误伤修复）。
 *
 * 策略：解析失败 / 数据库不可用 → 如实落 fullyTranslated=false，
 * 绝不猜一个数字填上去。
 */

import { DatabaseSync } from "node:sqlite";

import { Parser } from "node-sql-parser";

import { buildControlQuery } from "@/lib/sql/magnitude";

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
  /** 金额查询引用了成交单价（unit_price）而非标价时为 true —— 把 R2 口径亮给用户 */
  unitPriceUsed: boolean;
  /** 统计范围末端越过数据水位（asOf）—— 提示范围可能超出数据覆盖 */
  outOfWatermark: boolean;
  /** 已排除订单的金额合计 = 同范围无过滤控制总数 − 结果值；算不出时为 null */
  excludedMoneyTotal: number | null;
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
 * AST 是否含 SUM/AVG 金额聚合。与 lint ruleR1 的触发条件刻意保持一致：
 * lint 要求说明口径的查询范围 = 回执必须翻译的范围，二者不应对不上。
 */
function hasMoneyAggregate(ast: unknown): boolean {
  const walk = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(walk);
    if (!isRecord(node)) return false;
    if (node.type === "aggr_func" && typeof node.name === "string") {
      const name = node.name.toUpperCase();
      if (name === "SUM" || name === "AVG") return true;
    }
    return Object.values(node).some(walk);
  };
  return walk(ast);
}

/** AST 是否引用了成交单价列（unit_price）——guard 重建会带反引号，用序列化匹配 */
function referencesUnitPrice(ast: unknown): boolean {
  const walk = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(walk);
    if (!isRecord(node)) return false;
    if (node.type === "column_ref" && JSON.stringify(node).includes("unit_price")) return true;
    return Object.values(node).some(walk);
  };
  return walk(ast);
}

/**
 * 构建回执。shopDbPath 为 null（或库不可用）时跳过 COUNT，绝不猜数。
 * resultValue：loop 传入的结果金额值（仅单行结果时有意义），
 * 用于计算「已排除订单金额合计 = 同范围无过滤控制总数 − 结果值」。
 */
export function buildReceipt(input: {
  sql: string | null;
  resolution: { from: string; to: string } | null;
  asOf: string;
  shopDbPath: string | null;
  resultValue?: number;
}): ReceiptPayload {
  const base = {
    scope: input.resolution
      ? input.resolution.from === input.resolution.to
        ? input.resolution.from // 单日区间不写「X 至 X」
        : `${input.resolution.from} 至 ${input.resolution.to}`
      : "全时段",
    filters: [] as string[],
    method: "按查询结果直接统计",
    dataUntil: input.asOf,
    coverage: "见结果表格",
    excluded: [] as ReceiptExcluded[],
    unitPriceUsed: false,
    outOfWatermark: input.resolution ? input.resolution.to > input.asOf : false,
    excludedMoneyTotal: null as number | null,
  };

  if (input.sql === null) return { ...base, fullyTranslated: input.resolution !== null };

  let pinned = false;
  let money = false;
  let usesUnitPrice = false;
  try {
    const ast = new Parser().astify(input.sql, {
      // 与 lint.ts 同款断言：上游类型声明与运行时实参不一致（第 2 周实测）
      databaseType: "sqlite",
    } as never);
    money = hasMoneyAggregate(ast);
    pinned = sqlPinsCompletedAst(ast);
    usesUnitPrice = referencesUnitPrice(ast);
  } catch {
    return { ...base, fullyTranslated: false };
  }
  if (money) base.method = "按明细行成交小计汇总";
  if (money && usesUnitPrice) base.unitPriceUsed = true;

  if (!pinned) {
    // 未认出 status='已完成' 形状：
    //   有金额聚合 → R1 口径义务未说明白，如实 false；
    //   无金额聚合 → 本来就没有口径声明义务，不算翻译不全
    return { ...base, fullyTranslated: !money };
  }

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
        // 排除金额合计 = 同范围无过滤控制总数 − 结果值（两者都到手才算，绝不猜）
        if (typeof input.resultValue === "number" && Number.isFinite(input.resultValue)) {
          const controlSql = buildControlQuery(input.sql);
          if (controlSql) {
            const crow = db.prepare(controlSql).get() as Record<string, unknown> | undefined;
            const raw = crow ? Object.values(crow)[0] : null;
            const n = typeof raw === "number" ? raw : Number(raw);
            if (Number.isFinite(n)) base.excludedMoneyTotal = n - input.resultValue;
          }
        }
      } finally {
        db.close();
      }
    } catch {
      countsOk = false;
    }
  }
  return { ...base, fullyTranslated: countsOk };
}
