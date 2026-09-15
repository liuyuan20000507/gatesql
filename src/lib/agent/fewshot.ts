/**
 * few-shot 检索：确定性、阈值门控、宁缺毋滥（docs/05-agent-design.md 第四节）。
 *
 * 样本来源：app.db 的 corrections 表 —— 只取 enabled=1 且 verified_by_user=1 的
 * （入库前必须用户确认结果正确，防脏样本反向拉低准确率）。
 *
 * 确定性：打分 = 表重叠(每表 2 分) + 问题二元组重叠(每个 1 分)；
 * 平分按 id 字典序 —— 同一输入永远同一输出，这是评测可比的前提。
 */

import { DatabaseSync } from "node:sqlite";

export interface FewshotExample {
  id: string;
  question: string;
  sql: string;
  score: number;
}

/** 上限 2 条；score 低于阈值宁可不给（召回相似但口径不同的样例会帮倒忙） */
const MAX_EXAMPLES = 2;
const MIN_SCORE = 3;

/** 与 schema-context 同款：中文二元组（不共用是为了本模块零依赖除 DB 外） */
function cjkBigrams(text: string): string[] {
  const grams = new Set<string>();
  for (const chunk of text.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i + 2 <= chunk.length; i++) grams.add(chunk.slice(i, i + 2));
  }
  return [...grams];
}

function score(sampleQuestion: string, sampleTables: string[], qTables: Set<string>, qGrams: Set<string>): number {
  let s = 0;
  for (const t of sampleTables) if (qTables.has(t)) s += 2;
  for (const g of cjkBigrams(sampleQuestion)) if (qGrams.has(g)) s += 1;
  return s;
}

interface CorrectionRow {
  id: string;
  question: string;
  sql: string;
  tables: string;
}

/**
 * 从 corrections 里检索至多 MAX_EXAMPLES 条、score ≥ MIN_SCORE 的样本。
 * 无达标样本时返回空数组 —— prompt 宁缺毋滥。
 */
export function retrieveFewshots(db: DatabaseSync, question: string, tables: string[]): FewshotExample[] {
  const rows = db
    .prepare("SELECT id, question, sql, tables FROM corrections WHERE enabled = 1 AND verified_by_user = 1")
    .all() as unknown as CorrectionRow[];

  const qTables = new Set(tables);
  const qGrams = new Set(cjkBigrams(question));

  return rows
    .map((r) => {
      const cTables = new Set<string>((JSON.parse(r.tables) as string[]) ?? []);
      return { id: r.id, question: r.question, sql: r.sql, score: score(r.question, [...qTables], cTables, qGrams) };
    })
    .filter((e) => e.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, MAX_EXAMPLES);
}

/** 拼进系统提示词的段落；空样本返回空串（不产生空行污染） */
export function formatFewshotExamples(examples: FewshotExample[]): string {
  if (examples.length === 0) return "";
  const lines = ["", "参考示例（同口径的已验证写法，仅供风格参照，条件以本题为准）："];
  for (const e of examples) {
    lines.push(`问题：${e.question}`, `SQL：${e.sql}`);
  }
  return lines.join("\n");
}
