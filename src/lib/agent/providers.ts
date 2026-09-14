/**
 * LLM provider 适配层。
 *
 * 目标：不把 Caliber 绑死在某个供应商上。供应商之间真正不同的是
 * 「线上协议」（wire format），主流只有两种：
 *   - responses API      —— 火山 Coding Plan 实测只能用这个（chat.completions 404）
 *   - chat.completions   —— DeepSeek / OpenAI / 智谱 / Moonshot 等通用
 *
 * 对外只暴露 callLlm（llm.ts），它根据 pickWire() 选适配器。
 * 换供应商 = 改三个环境变量（LLM_BASE_URL + LLM_API_KEY + LLM_MODEL），
 * 不需要改任何业务代码。
 */

import OpenAI from "openai";

import type { LlmMessage } from "@/lib/agent/llm";

export type LlmWire = "responses" | "chat_completions";

export interface AdapterChatInput {
  model: string;
  messages: LlmMessage[];
  /** JSON Schema 结构化输出；上游不严格执行时调用方必须能降级（见 loop） */
  jsonSchema?: unknown;
  client: OpenAI;
}

export interface AdapterChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderAdapter {
  wire: LlmWire;
  chat(input: AdapterChatInput): Promise<AdapterChatResult>;
}

/** responses API（火山 Coding Plan 的 /api/coding/v3 实测形态） */
export class ResponsesAdapter implements ProviderAdapter {
  readonly wire = "responses" as const;

  async chat(input: AdapterChatInput): Promise<AdapterChatResult> {
    // openai SDK 7.x 对 text.format 的泛型覆盖不全，运行时结构正确
    const params = {
      model: input.model,
      input: input.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(input.jsonSchema
        ? { text: { format: { type: "json_schema", name: "result", schema: input.jsonSchema, strict: false } } }
        : {}),
    } as unknown as Parameters<typeof input.client.responses.create>[0];

    const res = (await input.client.responses.create(params)) as unknown as {
      output_text?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      text: res.output_text ?? "",
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
    };
  }
}

/** chat.completions 通用协议（DeepSeek / OpenAI / 智谱 / Moonshot …） */
export class ChatCompletionsAdapter implements ProviderAdapter {
  readonly wire = "chat_completions" as const;

  async chat(input: AdapterChatInput): Promise<AdapterChatResult> {
    const params = {
      model: input.model,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(input.jsonSchema
        ? {
            response_format: {
              type: "json_schema" as const,
              json_schema: { name: "result", schema: input.jsonSchema, strict: false },
            },
          }
        : {}),
    } as unknown as Parameters<typeof input.client.chat.completions.create>[0];

    const res = (await input.client.chat.completions.create(params)) as unknown as {
      choices: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: res.choices[0]?.message?.content ?? "",
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
    };
  }
}

/**
 * 协议选择：显式用环境变量 LLM_WIRE 覆盖；默认 auto 按 baseURL 推断。
 * 判定「/coding/」命中 responses —— 这是火山 Coding Plan 的特征路径。
 */
export function pickWire(baseURL: string, explicit?: "auto" | LlmWire): LlmWire {
  if (explicit && explicit !== "auto") return explicit;
  return /\/coding\//.test(baseURL) ? "responses" : "chat_completions";
}