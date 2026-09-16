/**
 * time.ts 与 schema-context.ts、llm replay 的验收测试。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveTimeRange } from "@/lib/agent/time";
import { buildSchemaContext } from "@/lib/agent/schema-context";
import { callLlm, cassetteKey } from "@/lib/agent/llm";
import { pickWire } from "@/lib/agent/providers";

const SHOP_DB = "data/shop.db";
const AS_OF = "2026-08-31";

describe("resolveTimeRange：相对时间确定性解析", () => {
  it("近30天 → 2026-08-02 ~ 2026-08-31（含 asOf 当天）", () => {
    const r = resolveTimeRange("近30天的销售额", AS_OF);
    expect(r?.from).toBe("2026-08-02");
    expect(r?.to).toBe("2026-08-31");
    expect(r?.expression).toBe("近30天");
  });

  it("上个月 → 2026-07-01 ~ 2026-07-31", () => {
    expect(resolveTimeRange("上个月的订单数", AS_OF)?.from).toBe("2026-07-01");
    expect(resolveTimeRange("上个月的订单数", AS_OF)?.to).toBe("2026-07-31");
  });

  it("特定年月 2025年2月 → 2 月整月（28 天）", () => {
    const r = resolveTimeRange("2025年2月的销售额", AS_OF);
    expect(r?.from).toBe("2025-02-01");
    expect(r?.to).toBe("2025-02-28");
  });

  it("去年 → 2025-01-01 ~ 2025-12-31", () => {
    const r = resolveTimeRange("去年的销售额", AS_OF);
    expect(r?.from).toBe("2025-01-01");
    expect(r?.to).toBe("2025-12-31");
  });

  it("上半年 → 2026-01-01 ~ 2026-06-30", () => {
    const r = resolveTimeRange("上半年各分类销售排名", AS_OF);
    expect(r?.from).toBe("2026-01-01");
    expect(r?.to).toBe("2026-06-30");
  });

  it("问题被改写：原表达替换为绝对区间", () => {
    const r = resolveTimeRange("上半年各分类销售排名", AS_OF);
    expect(r?.rewrittenQuestion).toContain("2026-01-01 至 2026-06-30");
    expect(r?.rewrittenQuestion).not.toContain("上半年");
  });

  it("无时间表达返回 null（不报错）", () => {
    expect(resolveTimeRange("客户端共有多少人", AS_OF)).toBeNull();
  });
});

describe("buildSchemaContext：确定性裁剪与枚举注入", () => {
  it("返回 schema 卡片，含表注释/列注释/枚举值", () => {
    const ctx = buildSchemaContext("销售额", SHOP_DB);
    expect(ctx.card).toContain("orders");
    expect(ctx.card).toContain("订单表");
    expect(ctx.card).toContain("已完成");
    expect(ctx.card).toContain("订单状态");
  });

  it("同一问题两次产出完全相同的卡片（确定性硬要求）", () => {
    const a = buildSchemaContext("各分类销售额排名", SHOP_DB).card;
    const b = buildSchemaContext("各分类销售额排名", SHOP_DB).card;
    expect(a).toBe(b);
  });

  it("外键闭包：只命中 orders 的「渠道销售额」必须带上 order_items（6B 实测 bug 回归）", () => {
    const ctx = buildSchemaContext("各下单渠道的「已完成」销售额分别是多少？", SHOP_DB);
    expect(ctx.selectedTables).toContain("order_items");
    expect(ctx.card).toContain("amount");
  });

  it("外键闭包：华东客户销售额问题带上明细表", () => {
    const ctx = buildSchemaContext("华东地区客户的「已完成」销售额是多少？", SHOP_DB);
    expect(ctx.selectedTables).toContain("order_items");
  });
});

describe("callLlm：cassette 回放", () => {
  beforeEach(() => {
    process.env.LLM_MODE = "replay";
    process.env.LLM_BASE_URL = "http://127.0.0.1:1"; // 回放不会真正请求
    process.env.LLM_MODEL = "test-model";
  });

  afterEach(() => {
    delete process.env.LLM_MODE;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
  });

  it("replay 模式从 cassette 返回且不发起网络请求", async () => {
    const messages = [{ role: "user" as const, content: "你好" }];
    const key = cassetteKey("chat_completions", "test-model", messages);
    const file = path.join("fixtures", "llm", `${key}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ text: "来自回放的回复", inputTokens: 10, outputTokens: 5 }), "utf-8");

    try {
      const result = await callLlm(messages);
      expect(result.fromCache).toBe(true);
      expect(result.text).toBe("来自回放的回复");
    } finally {
      // 测试自建的 cassette 必须清掉，不污染真实仓库
      rmSync(file, { force: true });
    }
  });

  it("replay 模式缺 cassette 时报错（提示先录制）", async () => {
    const messages = [{ role: "user" as const, content: "这句从没录过" }];
    await expect(callLlm(messages)).rejects.toThrow(/找不到 cassette/);
  });
});

describe("pickWire：对上协议推断", () => {
  it("火山 Coding Plan 的 /coding/ 路径 → responses", () => {
    const wire = pickWire("https://ark.cn-beijing.volces.com/api/coding/v3");
    expect(wire).toBe("responses");
  });

  it("DeepSeek / OpenAI 通用路径 → chat_completions", () => {
    expect(pickWire("https://api.deepseek.com/v1")).toBe("chat_completions");
    expect(pickWire("https://api.openai.com/v1")).toBe("chat_completions");
  });

  it("显式 LLM_WIRE 优先于推断", () => {
    expect(pickWire("https://api.deepseek.com/v1", "responses")).toBe("responses");
  });
});