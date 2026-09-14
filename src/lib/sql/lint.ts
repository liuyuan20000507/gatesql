/**
 * 口径 lint（fail-open）：用 AST 检查业务口径规则（R1~R8）。
 *
 * 与 guard（fail-closed）刻意不对称：guard 解析失败即拒绝，
 * 这里解析失败就放过并记 warn —— 口径检查不该阻断一个可能的合法查询
 * （见 docs/09-decisions.md ADR-008）。
 *
 * 消费方：loop.ts（手写）—— block 级违规带「缺失的具体谓词」回喂模型重生成；
 *          warn 级违规把答案预标记为「未核验」。
 *
 * 判定用启发式 + AST 结构，不追求完备（完备性属于语义层，被 ADR-014 明确砍掉）。
 *
 * 本实现基于实测的 v5 AST 形态（scripts/_tmp_probe_lint.ts）：
 *   - 聚合函数是 { type:'aggr_func', name:'SUM', args:{ expr, distinct } }，
 *     distinct 是字符串 'DISTINCT' 而不是布尔
 *   - JOIN 的连接条件挂在 from 项的顶层 on 键上（{table, as, join, on}）
 *   - groupby 形如 { columns:[...], modifiers:[...] }，不是纯数组
 */

import { Parser, type Option } from "node-sql-parser";

import { RULES_BY_ID } from "@/lib/sql/rules";
import type { LintViolation } from "@/lib/events";

export interface LintReport {
  violations: LintViolation[];
  /** 解析失败时为 true（fail-open，loop 应记 warn 而不是重试模型） */
  parseFailed: boolean;
}

/** 问题侧提示词（loop 传入），用于 R6/R7 这类需要结合自然人问题的规则 */
export interface LintHints {
  timeKeywords: string[];
  rankKeywords: string[];
}

const NULLABLE_GROUP_COLUMNS = new Set(["region", "channel", "status"]);

/* ------------------------------------------------------------------ */
/* AST 工具（基于实测形状）                                             */
/* ------------------------------------------------------------------ */

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * 剥掉标识符两端的引号。guard 的 sqlify 重建会给标识符套反引号
 * （SELECT `orders`.`id`），再喂回本 lint 解析时 Parser 会把这些反引号
 * 留在 table/column 里，导致别名查表和列名比较全部落空 —— 必须归一。
 */
function unquote(s: string): string {
  return s.replace(/^[`"']|[`"']$/g, "");
}

interface ColumnRef {
  table: string | null;
  column: string;
}

/**
 * 从 column_ref 里取表名。实测 v5 在反引号标识符下会把 table 解析成
 * { type: "backticks_quote_string", value: "o" } 这样的对象而非字符串。
 */
function tableNameOf(ref: Record<string, unknown>): string | null {
  const t = ref.table;
  if (typeof t === "string") {
    const clean = unquote(t);
    return clean ? clean : null;
  }
  if (typeof t === "object" && t !== null) {
    const v = (t as Record<string, unknown>).value;
    if (typeof v === "string") return v;
  }
  return null;
}

function collectColumnRefs(root: unknown, out: ColumnRef[]): void {
  if (Array.isArray(root)) return root.forEach((n) => collectColumnRefs(n, out));
  if (!isObject(root)) return;
  if (root.type === "column_ref" && typeof root.column === "string") {
    out.push({ table: tableNameOf(root), column: unquote(root.column) });
  }
  for (const v of Object.values(root)) collectColumnRefs(v, out);
}

/** 谓词位置的列引用：WHERE + HAVING + 所有 JOIN ON */
function collectPredicateRefs(select: Record<string, unknown>): ColumnRef[] {
  const refs: ColumnRef[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (isObject(node)) {
      if (node.type === "on" || node.type === "binary_expr") collectColumnRefs(node, refs);
      for (const v of Object.values(node)) visit(v);
    }
  };
  visit(select.where);
  visit(select.having);
  const from = select.from;
  if (Array.isArray(from)) {
    for (const item of from) if (isObject(item)) visit(item.on);
  }
  return refs;
}

interface FromInfo {
  aliasToTable: Map<string, string>;
  tables: Set<string>;
  /** 任意 from 项带 on 连接条件，或 where 出现跨表等值 */
  hasJoinCondition: boolean;
}

function buildFromInfo(select: Record<string, unknown>): FromInfo {
  const aliasToTable = new Map<string, string>();
  const tables = new Set<string>();
  let hasJoinCondition = false;
  const from = select.from;
  if (Array.isArray(from)) {
    for (const raw of from) {
      if (!isObject(raw)) continue;
      const name = raw.table;
      if (typeof name === "string") {
        tables.add(unquote(name));
        if (typeof raw.as === "string") aliasToTable.set(unquote(raw.as), unquote(name));
      }
      if (isObject(raw.on)) hasJoinCondition = true;
    }
  }
  return { aliasToTable, tables, hasJoinCondition };
}

function resolveTable(ref: ColumnRef, aliasToTable: Map<string, string>): string | null {
  if (ref.table) return aliasToTable.get(ref.table) ?? ref.table;
  return aliasToTable.size === 1 ? [...aliasToTable.values()][0] : null;
}

interface AggCall {
  name: string;
  distinct: boolean;
  /* 参数里的列引用（无参数如 COUNT(*) 为空） */
  argRefs: ColumnRef[];
}

/** v5 聚合函数节点：{ type:'aggr_func', name, args:{ expr, distinct } } */
function findAggCalls(select: Record<string, unknown>): AggCall[] {
  const calls: AggCall[] = [];
  const columns = Array.isArray(select.columns) ? select.columns.map((c) => (isObject(c) ? c.expr : c)) : [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isObject(node)) return;
    if (node.type === "aggr_func" && typeof node.name === "string") {
      const args = isObject(node.args) ? node.args : {};
      const argRefs: ColumnRef[] = [];
      collectColumnRefs(args.expr ?? {}, argRefs);
      calls.push({ name: String(node.name).toUpperCase(), distinct: args.distinct === "DISTINCT", argRefs });
    }
    for (const v of Object.values(node)) visit(v);
  };
  columns.forEach(visit);
  return calls;
}

function selectColumnExprs(select: Record<string, unknown>): unknown[] {
  return Array.isArray(select.columns)
    ? select.columns.map((c) => (isObject(c) ? c.expr : c))
    : [];
}

/** WHERE 等谓词位置里是否存在对某列的引用 */
function predicateHasColumn(select: Record<string, unknown>, column: string): boolean {
  return collectPredicateRefs(select).some((r) => r.column === column);
}

/* ------------------------------------------------------------------ */
/* 8 条规则                                                             */
/* ------------------------------------------------------------------ */

function ruleR1(select: Record<string, unknown>, aliasToTable: Map<string, string>): LintViolation | null {
  const hasAmount = findAggCalls(select).some((c) => ["SUM", "AVG"].includes(c.name));
  if (!hasAmount) return null;
  const predRefs = collectPredicateRefs(select);
  const statusRef = predRefs.find((r) => r.column === "status");
  const statusTable = statusRef ? resolveTable(statusRef, aliasToTable) : null;
  // 启发式：只要谓词里出现了 orders.status 列引用即视为已约束（可能有
  // 非「已完成」的等价写法，如 status <> '已取消' —— 交给后续等价性扩展）
  if (statusTable === "orders" && predicateHasColumn(select, "status")) return null;
  return {
    ruleId: "R1",
    level: "block",
    missingPredicate: "orders.status = '已完成'",
    suggestion: RULES_BY_ID.get("R1")!.description,
  };
}

function ruleR2(select: Record<string, unknown>, aliasToTable: Map<string, string>): LintViolation | null {
  const refs: ColumnRef[] = [];
  selectColumnExprs(select).forEach((e) => collectColumnRefs(e, refs));
  const priceRef = refs.find((r) => r.column === "price");
  if (!priceRef) return null;
  if (resolveTable(priceRef, aliasToTable) === "products") {
    return {
      ruleId: "R2",
      level: "block",
      missingPredicate: "金额相关计算应使用 order_items.unit_price 而非 products.price",
      suggestion: RULES_BY_ID.get("R2")!.description,
    };
  }
  return null;
}

function ruleR3(select: Record<string, unknown>, aliasToTable: Map<string, string>): LintViolation | null {
  const { tables } = buildFromInfo(select);
  if (!tables.has("order_items")) return null;
  const countCalls = findAggCalls(select).filter((c) => c.name === "COUNT" && !c.distinct);
  const orderCount = countCalls.find((c) =>
    c.argRefs.some((r) => resolveTable(r, aliasToTable) === "orders"),
  );
  if (!orderCount) return null;
  return {
    ruleId: "R3",
    level: "block",
    missingPredicate: "涉及 order_items 连接后，订单量必须使用 COUNT(DISTINCT orders.id)",
    suggestion: RULES_BY_ID.get("R3")!.description,
  };
}

function ruleR4(select: Record<string, unknown>): LintViolation | null {
  const gb = select.groupby;
  const columns = Array.isArray(gb) ? (gb as unknown[]) : isObject(gb) && Array.isArray(gb.columns) ? gb.columns : [];
  const grouped = columns
    .map((g) => {
      const rec = g as Record<string, unknown>;
      return typeof rec.column === "string" ? unquote(rec.column) : null;
    })
    .filter((c): c is string => c !== null);
  const nullableGrouped = grouped.filter((c) => NULLABLE_GROUP_COLUMNS.has(c));
  if (nullableGrouped.length === 0) return null;
  const exprText = selectColumnExprs(select).map((e) => JSON.stringify(e)).join(" ");
  const untouched = nullableGrouped.filter((c) => !/coalesce/i.test(exprText));
  if (untouched.length > 0) {
    return {
      ruleId: "R4",
      level: "warn",
      missingPredicate: `按可空列 GROUP BY 必须显式处理 NULL（例：COALESCE(${untouched.join("/")}, '未知')）`,
      suggestion: RULES_BY_ID.get("R4")!.description,
    };
  }
  return null;
}

function ruleR5(select: Record<string, unknown>): LintViolation | null {
  const detect = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(detect);
    if (!isObject(node)) return false;
    if (node.type === "binary_expr") {
      const refs: ColumnRef[] = [];
      collectColumnRefs(node, refs);
      const cols = refs.map((r) => r.column);
      if (cols.includes("price") && cols.includes("cost") && !cols.includes("unit_price")) return true;
    }
    return Object.values(node).some(detect);
  };
  if (selectColumnExprs(select).some(detect)) {
    return {
      ruleId: "R5",
      level: "block",
      missingPredicate: "毛利必须使用 unit_price - cost，而不是 price - cost",
      suggestion: RULES_BY_ID.get("R5")!.description,
    };
  }
  return null;
}

function ruleR6(select: Record<string, unknown>, hints: LintHints | undefined): LintViolation | null {
  if (!hints || hints.timeKeywords.length === 0) return null;
  if (!collectPredicateRefs(select).some((r) => r.column === "created_at")) {
    return {
      ruleId: "R6",
      level: "warn",
      missingPredicate: "趋势/对比类查询必须包含 orders.created_at 的时间范围条件",
      suggestion: RULES_BY_ID.get("R6")!.description,
    };
  }
  return null;
}

function ruleR7(select: Record<string, unknown>, hints: LintHints | undefined): LintViolation | null {
  if (!hints || hints.rankKeywords.length === 0) return null;
  const hasOrderBy = Array.isArray(select.orderby) && select.orderby.length > 0;
  const limit = isObject(select.limit) ? select.limit.value : null;
  const hasLimit = Array.isArray(limit) && limit.length > 0;
  if (!hasOrderBy || !hasLimit) {
    return {
      ruleId: "R7",
      level: "warn",
      missingPredicate: "排行类问题必须同时有 ORDER BY 和 LIMIT",
      suggestion: RULES_BY_ID.get("R7")!.description,
    };
  }
  return null;
}

function ruleR8(select: Record<string, unknown>): LintViolation | null {
  const { tables, hasJoinCondition } = buildFromInfo(select);
  if (tables.size < 2) return null;
  if (hasJoinCondition) return null;
  const predRefs = collectPredicateRefs(select);
  const qualified = predRefs.filter((r) => r.table !== null);
  if (qualified.length >= 2) return null;
  return {
    ruleId: "R8",
    level: "block",
    missingPredicate: "多表查询必须在 JOIN ON 或 WHERE 上存在连接条件",
    suggestion: RULES_BY_ID.get("R8")!.description,
  };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export function lintCaliber(sql: string, hints?: LintHints): LintReport {
  try {
    const parsed = new Parser().astify(sql, { databaseType: "sqlite" } as unknown as Option);
    if (Array.isArray(parsed)) {
      return {
        violations: [
          {
            ruleId: "R8",
            level: "block",
            missingPredicate: "一次只能检查一条语句",
            suggestion: "",
          },
        ],
        parseFailed: false,
      };
    }
    const ast = parsed as unknown as Record<string, unknown>;
    if (ast.type !== "select") return { violations: [], parseFailed: false };

    const { aliasToTable } = buildFromInfo(ast);
    const violations: LintViolation[] = [];

    for (const v of [
      ruleR1(ast, aliasToTable),
      ruleR2(ast, aliasToTable),
      ruleR3(ast, aliasToTable),
      ruleR4(ast),
      ruleR5(ast),
      ruleR6(ast, hints),
      ruleR7(ast, hints),
      ruleR8(ast),
    ]) {
      if (v) violations.push(v);
    }
    return { violations, parseFailed: false };
  } catch {
    return { violations: [], parseFailed: true };
  }
}