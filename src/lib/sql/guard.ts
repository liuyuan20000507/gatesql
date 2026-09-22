/**
 * SQL 安全检查（作者本人重写本文件 —— 面试必问，见自检清单）。
 *
 * 实现分层（docs/07-security.md 的**安全层号**，与 docs/05 的流程步骤号 A1~C4 是两套坐标系）：
 *   openReadOnlyConnection —— 第 1 层连接只读 + 第 2 层引擎级授权回调
 *   guardSql                —— 第 4 层语句层 AST 白名单（fail-closed）
 *
 * guardSql 内部用 ①~⑦ 标记它自己的检查次序（既不是流程步骤，也不是安全层）：
 *   ① 正则预检 ② 解析并判多语句 ③ 语句类型白名单 ④ 递归扫危险节点
 *   ⑤ 表名过滤 ⑥ LIMIT 注入/收紧 ⑦ sqlify 重建
 *
 * 本实现基于实测的 node-sql-parser v5 行为（见 scripts/_tmp_probe_ast*.cjs）：
 *   - 单条 SELECT 返回 { type:'select', ... }，多条语句返回数组
 *   - limit.value 在 v5 是「数组」[{ type:'number', value:N }]
 *   - CTE 藏写操作 / PRAGMA / ATTACH 在 v5 直接解析失败 —— 被 AST_PARSE_FAILED 兜住
 *   - EXPLAIN 能解析成功，type='explain' —— 需要按 type 白名单拦
 *   - 指定 databaseType:'sqlite'；sqlify 重建会给标识符加反引号（SQLite 合法）
 */

import { DatabaseSync } from "node:sqlite";
import { Parser, type AST, type Option } from "node-sql-parser";

function astifyWithSqliteDialect(parser: Parser, sql: string): unknown {
  // 实测：运行时只认 databaseType 键（window 函数在 database:'sqlite' 下
  // 会解析失败，且默认方言会破坏部分语法）；而 5.4.0 的类型声明误写成了
  // database —— 上游类型 bug，用断言绕开，运行时键保持正确。
  return parser.astify(sql, { databaseType: "sqlite" } as unknown as Option);
}

/* ------------------------------------------------------------------ */
/* 对外类型（消费方：executor.ts / loop.ts / route.ts，勿改签名）       */
/* ------------------------------------------------------------------ */

export type GuardReason =
  | "PATTERN_SEMICOLON"
  | "NOT_SELECT_OR_WITH"
  | "AST_PARSE_FAILED"
  | "DANGEROUS_NODE"
  | "AUTHORIZER_REJECTED";

export type GuardVerdict =
  | { ok: true; sql: string }
  | { ok: false; reason: GuardReason; detail?: string };

/* ------------------------------------------------------------------ */
/* 第 1 + 2 层：只读连接 + 引擎级授权回调                              */
/* ------------------------------------------------------------------ */

/**
 * SQLite authorizer 返回值语义（C API）：
 *   SQLITE_OK   = 0  —— 放行当前动作
 *   SQLITE_DENY = 1  —— 拒绝，整个语句报错中止
 * 注意与广大博客常见误述相反：0 才是允许。测试不校验返回值，只校验行为，
 * 写错这个会导致「全部放行」或「全部拒绝」，从测试红字可立刻看出。
 *
 * 实测（scripts/probe 系列，Node v24 + node:sqlite）：
 *   READ 动作上报的是 (列名, schema名)，例如 SELECT id FROM orders →
 *   [20, "id", "main"]；sqlite_master 这类内部虚拟表同样不携带表名。
 *   因此「引擎层按表名过滤内部表」在 node:sqlite 上无法实现，
 *   内部表读过滤必须由 guardSql 的语句层表名收集（⑤）承担。
 *   这是分层防护而非缺口：引擎层按动作码挡写/结构/外挂，语句层挡内部表读。
 */

const SQLITE_OK = 0;
const SQLITE_DENY = 1;

/** authorizer 动作码中最常用的几个（完整清单见 sqlite3.h） */
const ACTION_READ = 20;
const ACTION_SELECT = 21;
const ACTION_FUNCTION = 31;

/** 语句层内部表过滤用（见下）：schema 元数据由应用层喂给模型，不允许自查 */
const INTERNAL_TABLE_PREFIX = "sqlite_"; // sqlite_master / sqlite_sequence / ...
const BLOCKED_TABLES = ["_column_comments"];

function isBlockedTable(name: string): boolean {
  return name.startsWith(INTERNAL_TABLE_PREFIX) || BLOCKED_TABLES.includes(name);
}

/**
 * 收集 AST 里所有「表引用」。实测 v5 的 FROM/JOIN 表引用是
 * { db, table } 裸对象（没有 type 字段），而列引用 column_ref 是
 * { table, column } —— 用「有 table、无 column」来区分二者。
 * 返回去重后的表名集合。
 */
function collectTableNames(root: unknown): Set<string> {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      if (typeof rec.table === "string" && rec.column === undefined) {
        names.add(rec.table);
      }
      for (const value of Object.values(rec)) walk(value);
    }
  };
  walk(root);
  return names;
}

/**
 * 第 1 层 + 第 2 层。
 * 以只读模式打开被分析库，并装上授权回调。
 * 连接层 readOnly 是引擎级兜底；authorizer 是编译期闸门，二者互补。
 */
export function openReadOnlyConnection(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  db.setAuthorizer((action, _catalog, _table, _column, _arg) => {
    // 引擎层的职责边界（见文件头注释）：只按动作码拒绝，
    // 不尝试表名过滤 —— node:sqlite 的 READ 不携带表名，实测确认。
    if (action !== ACTION_READ && action !== ACTION_SELECT && action !== ACTION_FUNCTION) {
      return SQLITE_DENY;
    }
    return SQLITE_OK;
  });

  return db;
}

/* ------------------------------------------------------------------ */
/* 第 4 层：语句层 AST 白名单（fail-closed）                           */
/* ------------------------------------------------------------------ */

/** 在 AST 中视为危险的节点类型（含子查询/CTE 里嵌套的那些） */
const DANGEROUS_NODE_TYPES = new Set([
  "insert",
  "update",
  "delete",
  "drop",
  "truncate",
  "replace",
  "alter",
  "create",
  "rename",
  "attach",
  "detach",
  "pragma",
  "vacuum",
  "explain",
  "show",
  "set",
  "call",
  "load",
  "begin",
  "commit",
  "rollback",
]);

/**
 * 全树递归扫描。node-sql-parser 的 AST 就是普通对象/数组；
 * 遇到带 type 字段且落在危险集合里的节点即命中。
 */
function findDangerousNode(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findDangerousNode(item);
      if (hit) return hit;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (typeof rec.type === "string" && DANGEROUS_NODE_TYPES.has(rec.type)) {
      return rec.type;
    }
    for (const value of Object.values(rec)) {
      const hit = findDangerousNode(value);
      if (hit) return hit;
    }
  }
  return null;
}

/** 把 limit 规整成 v5 的 { seperator, value: [...] } 形态 */
function buildLimit(numberValue: number) {
  return { seperator: "", value: [{ type: "number", value: numberValue }] };
}

const MAX_ROWS = 1000;

/**
 * 第 4 层：语句级防护（fail-closed）。解析失败一律拒绝。
 * 返回 ok 时，sql 为已注入/收紧 LIMIT 的最终可执行语句。
 */
export function guardSql(rawSql: string): GuardVerdict {
  // —— ① 正则预检（廉价前置过滤）——
  // 去掉首部注释与空白后，只接受 SELECT / WITH 开头
  const stripped = rawSql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, "");
  if (!/^(select|with)\b/i.test(stripped)) {
    return { ok: false, reason: "NOT_SELECT_OR_WITH", detail: "只支持以 SELECT 或 WITH 开头的查询语句" };
  }

  // —— ② 解析并判定多语句 ——
  let parsed: unknown;
  try {
    parsed = astifyWithSqliteDialect(new Parser(), stripped);
  } catch {
    // 解析失败即拒绝。实测 v5 对 CTE 藏写操作 / PRAGMA / ATTACH 都会解析失败，
    // 这条路径天然兜住了它们。
    return { ok: false, reason: "AST_PARSE_FAILED", detail: "SQL 无法解析，已按不信任处理" };
  }

  if (Array.isArray(parsed)) {
    return { ok: false, reason: "PATTERN_SEMICOLON", detail: "检测到多条语句，一次只允许一条查询" };
  }

  const ast = parsed as Record<string, unknown>;

  // —— ③ 语句类型白名单 ——
  if (ast.type !== "select") {
    return {
      ok: false,
      reason: "DANGEROUS_NODE",
      detail: `检测到不允许的语句类型: ${String(ast.type)}`,
    };
  }

  // —— ④ 递归扫危险节点（含 with/子查询里的嵌套）——
  const hit = findDangerousNode(ast);
  if (hit) {
    return { ok: false, reason: "DANGEROUS_NODE", detail: `检测到危险语句片段: ${hit}` };
  }

  // —— ⑤ 表名过滤（系统表 / 注释表）——
  const blockedTables = [...collectTableNames(ast)].filter(isBlockedTable);
  if (blockedTables.length > 0) {
    return {
      ok: false,
      reason: "DANGEROUS_NODE",
      detail: `检测到不允许访问的表: ${blockedTables.join(", ")}`,
    };
  }

  // —— ⑥ LIMIT 注入 / 收紧（防结果集打爆内存和 SSE）——
  const limit = ast.limit as { value?: unknown } | null | undefined;
  const currentValue = Array.isArray(limit?.value) ? (limit.value[0] as { type?: string; value?: unknown } | undefined) : undefined;

  if (!limit) {
    ast.limit = buildLimit(MAX_ROWS);
  } else if (currentValue?.type === "number" && typeof currentValue.value === "number" && currentValue.value > MAX_ROWS) {
    ast.limit = buildLimit(MAX_ROWS);
  } else if (currentValue?.type !== "number") {
    // LIMIT 非数字常量（如 LIMIT 5 OFFSET 2 的组合、参数化、ALL）——
    // 统一收紧为默认上限，保证不会带着无限/大计数执行
    ast.limit = buildLimit(MAX_ROWS);
  }

  // —— ⑦ 重建 SQL 文本 ——
  try {
    const finalSql = new Parser().sqlify(ast as unknown as AST);
    return { ok: true, sql: finalSql };
  } catch {
    return { ok: false, reason: "AST_PARSE_FAILED", detail: "改写后的 SQL 重建失败，已按不信任处理" };
  }
}