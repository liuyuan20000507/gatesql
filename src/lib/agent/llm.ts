/**
 * LLM 调用层：协议无关（详见 providers.ts 的适配器）。
 *
 * 同一份基础设施、三个用途（docs/06-evaluation.md）：
 *   live      真实调用
 *   record    真实调用 + 把响应录成 cassette（fixtures/llm/<hash>.json）
 *   replay    完全离线，从 cassette 读 —— CI 门禁 / 调优重跑 / 无 key 演示
 *
 * cassette 键 = hash(wire + model + 规范化后的 messages + jsonSchema)。
 * 必须包含 wire：换供应商却复用旧响应，「优化后提升」就是假的。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import OpenAI from "openai";

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

export async function callLlm(
  messages: LlmMessage[],
  opts: { jsonSchema?: unknown } = {},
): Promise<LlmResult> {
  const env = getConfig();
  const mode: "live" | "record" | "replay" = env.LLM_MODE ?? (env.LLM_API_KEY ? "live" : "replay");
  const wire = pickWire(env.LLM_BASE_URL, env.LLM_WIRE);
  const key = cassetteKey(wire, env.LLM_MODEL, messages, opts.jsonSchema);

  if (mode === "replay") {
    const cached = readCassette(key);
    if (!cached) {
      throw new LlmError(`replay 模式找不到 cassette: ${key}（先以 record/live 模式跑一次生成它）`);
    }
    return { ...cached, fromCache: true };
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
  const result = await adapter.chat({ model: env.LLM_MODEL, messages, jsonSchema: opts.jsonSchema, client });

  if (mode === "record") {
    writeCassette(key, {
      text: result.text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
  }

  return { ...result, fromCache: false };
}