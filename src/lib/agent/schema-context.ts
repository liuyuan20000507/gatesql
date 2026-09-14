/**
 * schema 上下文工程：确定性裁剪 + 低基数列枚举值注入。
 *
 * 确定性是硬要求 —— 同一问题任何时候产出完全相同的上下文，否则评测的
 * 准确率变化无法归因。这是拒绝向量检索的真实理由（docs/09-decisions.md
 * ADR-009），不是「表少用不上」这个浅层说法。
 *
 * 表选择：问题关键词与「表名+表注释+列名+列注释」做二元组重叠打分，
 * 命中任何一个表就只保留命中表；一个都不命中就全给（4 张表兜底）。
 */

import { getConfig } from "@/lib/env";
import { readShopSchema, type SchemaTable } from "@/lib/db/schema";

export interface SchemaContext {
  selectedTables: string[];
  /** 拼好的 schema 卡片文本（喂给模型） */
  card: string;
}

/** 抽取问题里的中文片段，切成二元组用于匹配 */
function cjkBigrams(question: string): string[] {
  const grams = new Set<string>();
  for (const chunk of question.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i + 2 <= chunk.length; i++) grams.add(chunk.slice(i, i + 2));
  }
  return [...grams];
}

function tableHaystack(t: SchemaTable): string {
  const cols = t.columns.map((c) => `${c.name} ${c.comment}`).join(" ");
  return `${t.name} ${t.comment} ${cols}`;
}

function formatColumn(c: SchemaTable["columns"][number]): string {
  const parts: string[] = [];
  parts.push(`  ${c.name} ${c.type}` + (c.comment ? ` · ${c.comment}` : ""));
  // A/B 开关（docs/08 第 4 周）：off 时不注入枚举值，用来量化这项上下文工程值多少分
  if (c.enumValues && c.enumValues.length > 0 && getConfig().ENUM_INJECTION === "on") {
    parts.push(`    枚举: [${c.enumValues.join(" / ")}]`);
  }
  return parts.join("\n");
}

function buildCard(tables: SchemaTable[]): string {
  const lines: string[] = [];
  for (const t of tables) {
    lines.push(`表 ${t.name}` + (t.comment ? `（${t.comment}）` : "") + ` · ${t.rowCount} 行`);
    for (const c of t.columns) lines.push(formatColumn(c));
  }
  return lines.join("\n");
}

export function buildSchemaContext(question: string, dbPath: string): SchemaContext {
  const all = readShopSchema(dbPath);
  const grams = cjkBigrams(question);
  const scored = grams.length === 0 ? [] : all.filter((t) => grams.some((g) => tableHaystack(t).includes(g)));

  // 命中为空则全部兜底（本库 4 张表，全给也不会超出上下文）
  const selected = scored.length > 0 ? scored : all;

  return {
    selectedTables: selected.map((t) => t.name),
    card: buildCard(selected),
  };
}