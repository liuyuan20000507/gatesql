/**
 * LLM 调用层缓存行为的单测（不打真实网络）。
 *
 * record 模式缓存优先是第 4 周评测基建的完成标准：连续两次跑评测，
 * 第二次零 API 调用 —— 这里验证「键命中即复用、不发起网络请求」。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { callLlm, cassetteKey, LlmError, type LlmMessage } from "@/lib/agent/llm";

const PROBE_MESSAGES: LlmMessage[] = [{ role: "user", content: "llm-cache-probe-唯一探针" }];

function probeKey(): string {
  // 与 callLlm 内部同一套键规则（wire + model + messages）
  return cassetteKey("chat_completions", "test-model", PROBE_MESSAGES, undefined);
}

beforeEach(() => {
  process.env.LLM_WIRE = "chat_completions";
  process.env.LLM_MODEL = "test-model";
  process.env.LLM_BASE_URL = "https://llm-cache-probe.invalid/v3";
  process.env.LLM_API_KEY = "dummy-key";
  mkdirSync(path.join("fixtures", "llm"), { recursive: true });
});

afterEach(() => {
  const file = path.join("fixtures", "llm", `${probeKey()}.json`);
  if (existsSync(file)) rmSync(file);
});

describe("callLlm 缓存", () => {
  it("record 模式键命中 → 直接复用 cassette，不发起网络请求", async () => {
    process.env.LLM_MODE = "record";
    writeFileSync(
      path.join("fixtures", "llm", `${probeKey()}.json`),
      JSON.stringify({ text: "缓存命中", inputTokens: 1, outputTokens: 2 }),
      "utf-8",
    );
    const result = await callLlm(PROBE_MESSAGES);
    expect(result.text).toBe("缓存命中");
    expect(result.fromCache).toBe(true);
    expect(result.outputTokens).toBe(2);
  });

  it("replay 模式未命中 → 抛 LlmError（不静默降级）", async () => {
    process.env.LLM_MODE = "replay";
    const file = path.join("fixtures", "llm", `${probeKey()}.json`);
    if (existsSync(file)) rmSync(file);
    await expect(callLlm(PROBE_MESSAGES)).rejects.toBeInstanceOf(LlmError);
  });
});
