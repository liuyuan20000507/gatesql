import { describe, expect, it } from "vitest";

import { findAmbiguity, formatClarifyReason } from "@/lib/agent/clarify";

describe("findAmbiguity（口径歧义词典）", () => {
  it("E4 原题 → 命中利润率词条", () => {
    const e = findAmbiguity("我们的利润率怎么样？");
    expect(e?.id).toBe("profit_margin");
    expect(e?.options.length).toBeGreaterThanOrEqual(2);
  });

  it("E3 原题 → 命中复购率词条", () => {
    expect(findAmbiguity("上个月的复购率是多少？")?.id).toBe("repeat_rate");
  });

  it("用户已点明口径 → 放行（拦的是没说清，不是提了词）", () => {
    expect(findAmbiguity("按毛利口径算一下利润率")).toBeNull();
    expect(findAmbiguity("90 天窗口内的复购率是多少")).toBeNull();
  });

  it("毛利率不算歧义（词面上不含「利润率」，语义上也已具体）", () => {
    expect(findAmbiguity("各分类的毛利率是多少？")).toBeNull();
  });

  it("无关问题 → null", () => {
    expect(findAmbiguity("各分类的已完成销售额")).toBeNull();
  });

  it("拒答理由可读且点名歧义词", () => {
    const e = findAmbiguity("我们的利润率怎么样？");
    expect(e && formatClarifyReason(e)).toContain("利润率");
  });
});
