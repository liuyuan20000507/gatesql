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
  SHOP_DB_PATH: z.string().default("data/shop.db"),
  APP_DB_PATH: z.string().default("data/app.db"),
  /** 覆盖默认时钟（默认 = shop.db 的 max(orders.created_at)） */
  AS_OF_DATE: z.string().date().optional(),
  /** 单条查询超时 / 返回行数上限（与 guard 的 MAX_ROWS 语义一致） */
  QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  MAX_ROWS: z.coerce.number().int().positive().default(1000),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

let _cache: EnvConfig | null = null;

/**
 * 每次现取（不做模块级缓存）：Zod 解析成本可忽略，而缓存会让测试
 * 里改 process.env 后拿到的还是旧配置。生产路径每个请求只解析一次，
 * 无所谓缓存。
 */
export function getConfig(): EnvConfig {
  if (_cache) return _cache;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`环境变量配置不合法: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  }
  _cache = parsed.data;
  return _cache;
}