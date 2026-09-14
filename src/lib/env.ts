/**
 * 运行环境配置：全部从 process.env 读取，用 Zod 校验。
 * 允许缺失/默认值的字段显式标注；密钥缺失时自动走 replay 模式（见 llm.ts）。
 */

import { z } from "zod";

const EnvSchema = z.object({
  LLM_BASE_URL: z.string().url().default("https://ark.cn-beijing.volces.com/api/coding/v3"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("ark-code-latest"),
  /** live 真实调用 / record 录制 / replay 回放（无 key 或缺 key 时默认 replay） */
  LLM_MODE: z.enum(["live", "record", "replay"]).optional(),
  /** 线上协议：auto（按 baseURL 推断）/ responses / chat_completions */
  LLM_WIRE: z.enum(["auto", "responses", "chat_completions"]).default("auto"),
  SHOP_DB_PATH: z.string().default("data/shop.db"),
  APP_DB_PATH: z.string().default("data/app.db"),
  /** 覆盖默认时钟（默认 = shop.db 的 max(orders.created_at)） */
  AS_OF_DATE: z.string().date().optional(),
  /** 单条查询超时 / 返回行数上限（与 guard 的 MAX_ROWS 语义一致） */
  QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  MAX_ROWS: z.coerce.number().int().positive().default(1000),
  /** 上下文工程 A/B 开关（docs/08 第 4 周）：off 时 schema 卡片不注入低基数列枚举值 */
  ENUM_INJECTION: z.enum(["on", "off"]).default("on"),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

/**
 * 每次现取（不做模块级缓存）：Zod 解析成本可忽略，而缓存会让测试、
 * 评测脚本里改 process.env 后拿到的还是旧配置（实测踩过：eval.ts 先设
 * LLM_MODE 再调 getConfig，因缓存顺序错了也不报错，假象难查）。
 */
export function getConfig(): EnvConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`环境变量配置不合法: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  }
  return parsed.data;
}