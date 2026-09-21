/**
 * 列名静态核对（6G 后续优化②）：在执行前拦下「引用了不存在的列」的 SQL，
 * 反馈精确到「哪张表没有这列 + 该表真实列清单」——比数据库报错
 * （no such column: oi.amt）更进一步：直接把候选答案递回模型。
 *
 * 误报纪律（新增检查层的生命线）：只核对「带前缀且前缀解析到真实表」的列引用。
 * 无前缀列（多表歧义）、CTE/子查询别名、表达式结果一律跳过——
 * 宁漏不误杀：漏了还有数据库兜底（execRetries 路径不变），误杀是白烧预算+冤枉好 SQL。
 */

import { DatabaseSync } from "node:sqlite";

import { Parser } from "node-sql-parser";

export interface ColumnCheckVerdict {
  ok: boolean;
  /** fail 时的人话诊断（缺失列 + 该表真实列清单），进 repairHistory 回喂 */
  detail?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function unquote(s: string): string {
  return s.replace(/^[`"[]|[`"\]]$/g, "");
}

/** 读每张真实表的列名集合（只读连接，轻量 PRAGMA） */
export function listTableColumns(dbPath: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all() as Array<{ name: string }>;
      map.set(
        t.name,
        new Set(cols.map((c) => c.name)),
      );
    }
  } finally {
    db.close();
  }
  return map;
}

/**
 * 核对 SQL 中带真实表前缀的列引用。
 * 解析失败 fail-open（lint 同款哲学：口径/引用检查不该阻断可能的合法查询）。
 */
export function checkColumnReferences(sql: string, schema: Map<string, Set<string>>): ColumnCheckVerdict {
  let ast: unknown;
  try {
    ast = new Parser().astify(sql, { databaseType: "sqlite" } as never);
  } catch {
    return { ok: true };
  }
  if (!isRecord(ast) || ast.type !== "select") return { ok: true };

  // 别名 → 真实表 映射（FROM/JOIN 项）；CTE 名收集为「不核对」名单
  const aliasToTable = new Map<string, string>();
  const realTables = new Set<string>();
  const from = ast.from;
  if (Array.isArray(from)) {
    for (const item of from) {
      if (!isRecord(item) || typeof item.table !== "string") continue;
      const table = unquote(item.table);
      if (typeof item.as === "string") aliasToTable.set(unquote(item.as), table);
      aliasToTable.set(table, table);
      if (schema.has(table)) realTables.add(table);
    }
  }

  // 收集列引用：只核对 {table: 前缀} 指向真实表的（含带前缀的列对象形态）
  const refs: Array<{ table: string; column: string }> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isRecord(node)) return;
    if (node.type === "column_ref" && typeof node.column === "string") {
      const t = node.table;
      const prefix =
        typeof t === "string" ? unquote(t) : isRecord(t) && typeof t.value === "string" ? unquote(t.value) : null;
      if (prefix) refs.push({ table: prefix, column: unquote(node.column) });
    }
    Object.values(node).forEach(walk);
  };
  walk(ast);

  for (const ref of refs) {
    const table = aliasToTable.get(ref.table) ?? ref.table;
    const columns = schema.get(table);
    if (!columns) continue; // 前缀不是真实表（CTE/子查询）→ 跳过
    if (ref.column === "*") continue;
    if (!columns.has(ref.column)) {
      const list = [...columns].slice(0, 12).join(", ");
      return {
        ok: false,
        detail: `表 ${table} 不存在列 ${ref.column}；该表可用列：${list}`,
      };
    }
  }
  return { ok: true };
}
