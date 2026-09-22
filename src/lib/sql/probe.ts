/**
 * 空结果归因探针（5E，docs/05 C1(a)）：查询返回 0 行（或聚合单个 NULL）时，
 * 按「时间范围 → 枚举值过滤 → 可空列 → 全部 WHERE」的顺序，
 * 每次只放宽一类条件、包成 COUNT(*) 重跑（最多 4 条）——
 * 哪类条件一放宽就有数据，元凶就是它。全部是代码生成的确定性改写，只跑 COUNT。
 *
 * 输入约定：guard 重建后的 SQL（单行、反引号标识符、LIMIT 由 guard 追加）。
 * 顶层 AND 切分尊重引号/括号，且 BETWEEN 的第二段 AND 不拆（否则留下半截谓词）。
 */

export interface Probe {
  label: string;
  sql: string;
}

interface WhereShape {
  prefix: string;
  conds: string[];
  tail: string;
}

/** 按顶层 AND 切分：引号内不切、括号内不切、BETWEEN x AND y 不切 */
function splitTopLevelAnd(body: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let quote: string | null = null;
  let pendingBetween = false;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (quote !== null) {
      cur += ch;
      if (ch === quote) {
        if (body[i + 1] === quote) {
          cur += body[i + 1];
          i += 2;
          continue;
        }
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && /^ and /i.test(body.slice(i, i + 5))) {
      if (pendingBetween) {
        cur += body.slice(i, i + 5);
        i += 5;
        pendingBetween = false;
        continue;
      }
      parts.push(cur.trim());
      cur = "";
      i += 5;
      continue;
    }
    cur += ch;
    if (/\bbetween$/i.test(cur.trimEnd())) pendingBetween = true;
    i++;
  }
  if (cur.trim().length > 0) parts.push(cur.trim());
  return parts;
}

/** 拆出 WHERE 的顶层条件 + 前后缀；找不到 WHERE 返回 null */
export function splitWhere(sql: string): WhereShape | null {
  const whereIdx = sql.search(/\bWHERE\b/i);
  if (whereIdx < 0) return null;
  const prefix = sql.slice(0, whereIdx);
  let body = sql.slice(whereIdx + "WHERE".length);
  let tail = "";
  // GROUP BY / ORDER BY / LIMIT 及其后内容整体归入尾部（它们是条件块的后继子句）
  const tailMatch = body.match(/\b(GROUP\s+BY|ORDER\s+BY|LIMIT)\b/i);
  if (tailMatch && tailMatch.index !== undefined) {
    tail = " " + body.slice(tailMatch.index).trim();
    body = body.slice(0, tailMatch.index);
  }
  const conds = splitTopLevelAnd(body).filter((c) => c.length > 0);
  if (conds.length === 0) return null;
  return { prefix, conds, tail };
}

const RELAXERS: Array<{ label: string; test: (cond: string) => boolean }> = [
  { label: "时间范围", test: (c) => /created_at|registered_at/i.test(c) },
  { label: "订单状态过滤", test: (c) => /\bstatus\b/i.test(c) },
  { label: "可空列等值过滤（region/channel）", test: (c) => /\b(region|channel)\b/i.test(c) },
];

function rebuild(w: WhereShape, kept: string[]): string {
  const base = w.prefix.trim();
  const body = kept.length === 0 ? "" : ` WHERE ${kept.join(" AND ")}`;
  return `${base}${body}${w.tail}`.replace(/\s+/g, " ").trim();
}

/** 放宽后的探针查询：聚合无 GROUP BY 时，把 SELECT 列表换成 COUNT(*)
 *  直接数底表行（否则放宽后的聚合永远只回一行，「放宽后有 N 行」失去意义）；
 *  带 GROUP BY 或非聚合的，包一层 COUNT 数列数 */
function probeCountSql(inner: string): string {
  const hasGroupBy = /\bGROUP\s+BY\b/i.test(inner);
  const isAggregate = /SUM\(|AVG\(|COUNT\(|MIN\(|MAX\(/i.test(inner);
  if (isAggregate && !hasGroupBy) {
    const fromIdx = inner.search(/\sFROM\s/i);
    if (fromIdx > 0) return `SELECT COUNT(*) AS probe_count${inner.slice(fromIdx)}`;
  }
  return `SELECT COUNT(*) AS probe_count FROM (${inner}) AS probe_t`;
}

/** 生成探针列表（≤4，库里没有的条件类跳过） */
export function buildEmptyResultProbes(sql: string): Probe[] {
  const w = splitWhere(sql);
  if (!w) return [];
  const probes: Probe[] = [];
  for (const r of RELAXERS) {
    if (!w.conds.some(r.test)) continue;
    const kept = w.conds.filter((c) => !r.test(c));
    if (kept.length === w.conds.length) continue;
    probes.push({ label: r.label, sql: probeCountSql(rebuild(w, kept)) });
    if (probes.length >= 3) break;
  }
  const hasAny = probes.length > 0;
  if (w.conds.length > 1 || !hasAny) {
    probes.push({ label: "全部过滤条件", sql: probeCountSql(rebuild(w, [])) });
  }
  return probes.slice(0, 4);
}
