import { describe, expect, it } from "vitest";

import { LEXICON, findAmbiguity, formatClarifyReason } from "@/lib/agent/clarify";

describe("findAmbiguity（A4 第一道子检查 · 歧义词典）", () => {
  it("关键词命中 → 返回词条", () => {
    expect(findAmbiguity("上个月的利润率是多少")?.id).toBe("profit_margin");
    expect(findAmbiguity("复购率怎么算")?.id).toBe("repeat_rate");
    expect(findAmbiguity("客单价是多少")?.id).toBe("avg_order_value");
    expect(findAmbiguity("卖得最好的商品")?.id).toBe("top_seller_metric");
    expect(findAmbiguity("退货率是多少")?.id).toBe("refund_rate");
  });

  it("关键词 + 任一 disambiguator → 放行（null）", () => {
    expect(findAmbiguity("按毛利口径的利润率")).toBeNull();
    expect(findAmbiguity("自然月口径的复购率")).toBeNull();
    expect(findAmbiguity("按每单平均的客单价")).toBeNull();
    expect(findAmbiguity("按销售额排名卖得最好的商品")).toBeNull();
    expect(findAmbiguity("按订单数计算的退货率")).toBeNull();
  });

  it("无关键词 → null", () => {
    expect(findAmbiguity("上个月的销售额是多少")).toBeNull();
    expect(findAmbiguity("有多少客户下过单")).toBeNull();
  });
});

describe("防循环：每个选项的 clarifyPhrase 必让第二轮放行（多轮澄清的生命线）", () => {
  // 若某选项话术缺 disambiguator，用户点它会再次被拦 → 弹同样选项 → 无限打转
  it("全部词条 × 全部选项：原问题 + clarifyPhrase 不再命中词典", () => {
    for (const entry of LEXICON) {
      for (const opt of entry.options) {
        const refined = `上个月的${entry.keywords[0]}是多少${opt.clarifyPhrase}`;
        expect(findAmbiguity(refined), `${entry.id} / ${opt.label}：话术「${opt.clarifyPhrase}」未通关`).toBeNull();
      }
    }
  });

  it("全部选项的 clarifyPhrase 必含本词条至少一个 disambiguator", () => {
    for (const entry of LEXICON) {
      for (const opt of entry.options) {
        const hit = entry.disambiguators.some((d) => opt.clarifyPhrase.includes(d));
        expect(hit, `${entry.id} / ${opt.label}`).toBe(true);
      }
    }
  });

  it("formatClarifyReason 输出含关键词且提示重新提问", () => {
    const entry = LEXICON[0];
    const reason = formatClarifyReason(entry);
    expect(reason).toContain(entry.keywords[0]);
    expect(reason).toContain("口径");
  });
});
