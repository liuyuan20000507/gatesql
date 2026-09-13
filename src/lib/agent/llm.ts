/**
 * LLM 调用层：OpenAI 兼容接口（火山 Coding Plan 的 responses API，实测
 * chat.completions 在其 /v3 返回 404 —— 见 scripts/probe_llm.ts 的发现）。
 *
 * 同一份基础设施、三个用途（docs/06-evaluation.md）：
 *   live      真实调用
 *   record    真实调用 + 把响应录成 cassette（fixtures/llm/<hash>.json）
 *   replay    完全离线，从 cassette 读 —— CI 门禁 / 调优重跑 / 无 key 演示
 *
 * cassette 键 = hash(model + 规范化后的 messages + jsonSchema)。
 * 键太糙（漏了 messages）会导致提示词改了却复用旧响应，「优化后提升」是假的。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import OpenAI from "openai";

import { getConfig } from "@/lib/env";

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
export function cassetteKey(model: string, messages: LlmMessage[], jsonSchema?: unknown): string {
  const payload = JSON.stringify({ model, messages, schema: jsonSchema ?? null });
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
  const key = cassetteKey(env.LLM_MODEL, messages, opts.jsonSchema);

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
    timeout: 30_000,
  });

  // SDK 7.x 对 responses API 的 text.format 泛型覆盖不全（类型缺索引签名），
  // 运行时结构是正确的；先构造好对象再整体断言到参数类型上。
  const createParams = {
    model: env.LLM_MODEL,
    input: messages.map((m) => ({ role: m.role, content: m.content })),
    ...(opts.jsonSchema
      ? { text: { format: { type: "json_schema", name: "result", schema: opts.jsonSchema, strict: false } } }
      : {}),
  } as unknown as Parameters<typeof client.responses.create>[0];

  const res = (await client.responses.create(createParams)) as unknown as {
    output_text?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = res.output_text ?? "";
  const usage = res.usage;
  const result: LlmResult = {
    text,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    fromCache: false,
  };

  if (mode === "record") {
    writeCassette(key, { text, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
  }

  return result;
}