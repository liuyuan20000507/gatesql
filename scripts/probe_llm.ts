/**
 * 第 0 阶段 0.5 的验证脚本：确认大模型链路能调通。
 *
 * 火山 Coding Plan 有两种接口形态，脚本会依次尝试：
 *   1. chat.completions（/api/v3，标准 OpenAI 兼容）
 *   2. responses（/api/coding/v3，Coding Plan 专用）
 *
 * 用法：pnpm tsx scripts/probe_llm.ts
 */

import { readFileSync } from "node:fs";
import OpenAI from "openai";

// 极简 .env.local 解析（避免为 5 个变量引入 dotenv 依赖）
function loadEnvLocal() {
  try {
    const raw = readFileSync(".env.local", "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    console.error("找不到 .env.local —— 先创建并填入 LLM_API_KEY");
    process.exit(1);
  }
}

async function tryChatCompletions(baseURL: string, apiKey: string, model: string) {
  const client = new OpenAI({ baseURL, apiKey, timeout: 30000 });
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "请只回复两个字：你好" }],
  });
  return res.choices[0]?.message?.content;
}

async function tryResponses(baseURL: string, apiKey: string, model: string) {
  const client = new OpenAI({ baseURL, apiKey, timeout: 30000 });
  // @ts-expect-error — responses API 在 SDK 类型里可能滞后，运行时可用
  const res = await client.responses.create({
    model,
    input: "请只回复两个字：你好",
  });
  // @ts-expect-error — 同上
  return res.output_text;
}

async function main() {
  loadEnvLocal();
  const apiKey = process.env.LLM_API_KEY!;
  const model = process.env.LLM_MODEL ?? "ark-code-latest";
  console.log(`模型: ${model}`);
  console.log("测试问题: 请只回复两个字：你好\n");

  const attempts = [
    { name: "chat.completions @ /api/v3", fn: () => tryChatCompletions("https://ark.cn-beijing.volces.com/api/v3", apiKey, model) },
    { name: "responses @ /api/coding/v3", fn: () => tryResponses(process.env.LLM_BASE_URL!, apiKey, model) },
  ];

  for (const a of attempts) {
    try {
      const answer = await a.fn();
      console.log(`✓ ${a.name} 成功`);
      console.log(`  模型回复: ${answer}`);
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗ ${a.name} 失败: ${msg.slice(0, 160)}`);
    }
  }
  console.error("\n两种方式都失败 —— 检查 key 是否有效、模型名是否正确。");
  process.exit(1);
}

main();
