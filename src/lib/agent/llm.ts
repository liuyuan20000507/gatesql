/**
 * LLM 调用层：协议无关（详见 providers.ts 的适配器）。
 *
 * 同一份基础设施、三个用途（docs/06-evaluation.md）：
 *   live      真实调用
 *   record    磁盘缓存优先：键命中直接复用 cassette（0 API 调用），未命中才真调并录制
 *   replay    完全离线，从 cassette 读 —— CI 门禁 / 调优重跑 / 无 key 演示
 *
 * cassette 键 = hash(wire + model + 规范化后的 messages + jsonSchema)。
 * 必须包含 wire：换供应商却复用旧响应，「优化后提升」就是假的。
 * record 的缓存优先意味着：连续两次跑评测，第二次零 API 调用（docs/08 第 4 周完成标准）；
 * 提示词一变键就变，自然会 miss 并录制新响应。要强制重录同一提示词，删掉对应文件即可。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import OpenAI from "openai";

import { getTodayCostCny, openAppDb } from "@/lib/db/app";
import { getConfig } from "@/lib/env";
import { ChatCompletionsAdapter, ResponsesAdapter, pickWire, type LlmWire } from "@/lib/agent/providers";

export class LlmError extends Error {}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** 本次是否来自 cassette 回放而非真实调用 */
  fromCache: boolean;
}

interface Cassette {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** 导出以便测试/评测脚本复现相同的键 */
export function cassetteKey(wire: LlmWire, model: string, messages: LlmMessage[], jsonSchema?: unknown): string {
  const payload = JSON.stringify({ wire, model, messages, schema: jsonSchema ?? null });
  return createHash("sha1").update(payload).digest("hex");
}

function fixturePath(key: string): string {
  return path.join("fixtures", "llm", `${key}.json`);
}

function readCassette(key: string): Cassette | null {
  try {
    return JSON.parse(readFileSync(fixturePath(key), "utf-8")) as Cassette;
  } catch {
    return null;
  }
}

function writeCassette(key: string, data: Cassette): void {
  mkdirSync(path.dirname(fixturePath(key)), { recursive: true });
  writeFileSync(fixturePath(key), JSON.stringify(data, null, 2), "utf-8");
}

/** 模式判定：显式 LLM_MODE 优先；无 key 自动 replay（无 key 演示的关键） */
export function resolveMode(env: { LLM_MODE?: "live" | "record" | "replay"; LLM_API_KEY?: string }): "live" | "record" | "replay" {
  return env.LLM_MODE ?? (env.LLM_API_KEY ? "live" : "replay");
}

/**
 * 预算护栏（docs/08 6F）：日预算 >= 0 且今日已花 >= 预算 → live/record 强制降级 replay。
 * 降级强于显式 LLM_MODE——「把预算调成 0 再提问」必须触发，否则护栏形同虚设；
 * budget = -1 表示不限。spentToday 恒 0（计价 P2 未实现）的今天，budget=0 即触发，
 * 这正是验收路径；计价落地后同一函数自动覆盖「部分超支」场景。
 */
export function applyBudget(
  mode: "live" | "record" | "replay",
  spentToday: number,
  budgetCny: number,
): "live" | "record" | "replay" {
  if (mode !== "replay" && budgetCny >= 0 && spentToday >= budgetCny) return "replay";
  return mode;
}

export async function callLlm(
  messages: LlmMessage[],
  opts: { jsonSchema?: unknown } = {},
): Promise<LlmResult> {
  const env = getConfig();
  let mode = resolveMode(env);
  // 预算护栏：今日花费触及日预算 → 强制降级 replay（docs/08 6F）。
  // 今日花费需查 app.db（openAppDb 自动建库建表；开销毫秒级，SQLite 本地读写）
  if (mode !== "replay" && env.DAILY_BUDGET_CNY >= 0) {
    const db = openAppDb(env.APP_DB_PATH);
    try {
      mode = applyBudget(mode, getTodayCostCny(db), env.DAILY_BUDGET_CNY);
    } finally {
      db.close();
    }
  }
  const wire = pickWire(env.LLM_BASE_URL, env.LLM_WIRE);
  const key = cassetteKey(wire, env.LLM_MODEL, messages, opts.jsonSchema);

  // replay 与 record 都缓存优先；live 永远真调
  if (mode !== "live") {
    const cached = readCassette(key);
    if (cached) return { ...cached, fromCache: true };
    if (mode === "replay") {
      throw new LlmError(`replay 模式找不到 cassette: ${key}（先以 record/live 模式跑一次生成它）`);
    }
  }

  if (!env.LLM_API_KEY) {
    throw new LlmError("live/record 模式需要 LLM_API_KEY");
  }

  const client = new OpenAI({
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    // 上游（火山 Coding Plan / DeepSeek）响应通常 10-40 秒，给足余量
    timeout: 90_000,
  });

  const adapter = wire === "responses" ? new ResponsesAdapter() : new ChatCompletionsAdapter();

  // 429 退避重试：上游限流是常态（连发评测时实测高发），等 30s 重试一次，
  // 再失败才向上抛。live/record 共用；replay 不会走到这里
  let result;
  try {
    result = await adapter.chat({ model: env.LLM_MODEL, messages, jsonSchema: opts.jsonSchema, client });
  } catch (err) {
    const is429 = err instanceof Error && /429|too frequent/i.test(err.message);
    if (!is429) throw err;
    await new Promise((r) => setTimeout(r, 30_000));
    result = await adapter.chat({ model: env.LLM_MODEL, messages, jsonSchema: opts.jsonSchema, client });
  }

  if (mode === "record") {
    writeCassette(key, {
      text: result.text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
  }

  return { ...result, fromCache: false };
}