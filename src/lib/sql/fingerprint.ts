/**
 * 语义指纹（6G⑦）：给「意思等价、写法不同」的 SQL 撞出同一个指纹，
 * 补文本指纹防不住的震荡——条件换序、别名互换。
 *
 * 只认两条可证明安全的等价（对齐 docs/05「宁可漏抓不可误杀」）：
 *   ① AND / OR 链的操作数排序（交换律是定理，无条件成立）
 *   ② 列引用的表别名归约为真实表名（o.status == orders.status）
 * 明确不碰：JOIN 顺序（内连接等价但外连接不等价，单靠 AST 分不清）、
 *   `x<=5` vs `x<6`（依赖「x 是数值」前提）、子查询↔JOIN 改写（结构差异过大）。
 *
 * 过度合并的护栏：AND 叶子按「整条序列化」排序——操作数集合不同（哪怕只是换了值）
 * 就是不同的排序结果 → 不同指纹。只有「同样的操作数换个顺序」才会撞上。
 */

import { createHash } from "node:crypto";

import { Parser } from "node-sql-parser";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function unquote(s: string): string {
  return s.replace(/^[`"\[]|[`"\]]$/g, "");
}

/** 从 FROM/JOIN 提取 别名 → 真实表名（含表名自映射，便于归一 orders.x） */
function buildAliasMap(ast: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  const from = ast.from;
  if (!Array.isArray(from)) return map;
  for (const item of from) {
    if (!isRecord(item) || typeof item.table !== "string") continue;
    const real = unquote(item.table);
    map.set(real, real);
    if (typeof item.as === "string" && item.as) map.set(unquote(item.as), real);
  }
  return map;
}

/** 把列引用的表名解析到真实表，并删除 FROM 项残留的 as 别名（列已归一，别名无意义） */
function resolveAndStripAliases(node: unknown, alias: Map<string, string>): void {
  if (Array.isArray(node)) {
    for (const item of node) resolveAndStripAliases(item, alias);
    return;
  }
  if (!isRecord(node)) return;

  if (node.type === "column_ref") {
    const t = node.table;
    if (typeof t === "string") {
      const r = alias.get(unquote(t));
      if (r) node.table = r;
    } else if (isRecord(t) && typeof t.value === "string") {
      const r = alias.get(unquote(t.value));
      if (r) t.value = r;
    }
  }
  if (typeof node.as === "string" && typeof node.table === "string") {
    delete node.as; // FROM 项别名：列引用已归一到真实表，删掉避免 o/x 差异
  }

  for (const value of Object.values(node)) resolveAndStripAliases(value, alias);
}

/** 原地归一：AND/OR 叶子按序列化排序（递归）。列引用/别名已在上一步处理 */
function canonicalize(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) canonicalize(item);
    return;
  }
  if (!isRecord(node)) return;

  if (
    node.type === "binary_expr" &&
    (node.operator === "AND" || node.operator === "OR")
  ) {
    const op = node.operator as "AND" | "OR";
    const leaves: unknown[] = [];
    const flatten = (n: unknown): void => {
      if (isRecord(n) && n.type === "binary_expr" && n.operator === op) {
        flatten(n.left);
        flatten(n.right);
      } else {
        leaves.push(n);
      }
    };
    flatten(node);
    for (const leaf of leaves) canonicalize(leaf); // 先归一子树，再按归一后的形态排序
    leaves.sort((a, b) => (serialize(a) < serialize(b) ? -1 : serialize(a) > serialize(b) ? 1 : 0));
    // 重建成右结合的 AND/OR 链，顺序已由排序固定
    let rebuilt: unknown = leaves[leaves.length - 1];
    for (let i = leaves.length - 2; i >= 0; i--) {
      rebuilt = { type: "binary_expr", operator: op, left: leaves[i], right: rebuilt };
    }
    Object.keys(node).forEach((k) => delete node[k]);
    Object.assign(node, rebuilt);
    return;
  }

  for (const value of Object.values(node)) canonicalize(value);
}

/** 稳定序列化：对象键排序后拼接（数组顺序保留——除已被排序的 AND/OR 链） */
function serialize(node: unknown): string {
  if (Array.isArray(node)) return "[" + node.map(serialize).join(",") + "]";
  if (!isRecord(node)) return JSON.stringify(node) ?? "null";
  const keys = Object.keys(node).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + serialize(node[k])).join(",") + "}";
}

/**
 * 语义指纹。解析成功 → "sem:"+sha1（归一后 AST 哈希）；
 * 解析失败 → 退回 "txt:"+文本归一（保持原文本指纹行为，绝不让新层成为回归源）。
 */
export function semanticFingerprint(sql: string): string {
  let ast: unknown;
  try {
    ast = new Parser().astify(sql, { databaseType: "sqlite" } as never);
  } catch {
    return "txt:" + sql.replace(/\s+/g, " ").trim().toLowerCase();
  }
  if (Array.isArray(ast)) {
    // 多语句：文本指纹兜底（正常已被 guard 拦在循环外，走到这里说明异常，保守处理）
    return "txt:" + sql.replace(/\s+/g, " ").trim().toLowerCase();
  }
  if (!isRecord(ast)) return "txt:" + sql.replace(/\s+/g, " ").trim().toLowerCase();

  const alias = buildAliasMap(ast);
  resolveAndStripAliases(ast, alias); // ② 别名归约为真实表名
  canonicalize(ast); // ① AND/OR 叶子按序列化排序
  return "sem:" + createHash("sha1").update(serialize(ast)).digest("hex");
}
