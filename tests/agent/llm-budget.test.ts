import { describe, expect, it } from "vitest";

import { applyBudget, resolveMode } from "@/lib/agent/llm";

describe("applyBudget（6F 预算护栏）", () => {
  it("今日已花 >= 预算 → live/record 强制降级 replay", () => {
    expect(applyBudget("live", 20, 20)).toBe("replay"); // 恰好触及
    expect(applyBudget("live", 25, 20)).toBe("replay"); // 已超支
    expect(applyBudget("record", 1, 0)).toBe("replay"); // 预算 0：0 >= 0 恒真
  });

  it("未触及预算 → 模式原样保留", () => {
    expect(applyBudget("live", 0, 20)).toBe("live");
    expect(applyBudget("live", 19.99, 20)).toBe("live");
    expect(applyBudget("record", 5, 20)).toBe("record");
  });

  it("budget = -1（不限）→ 永不降级", () => {
    expect(applyBudget("live", 0, -1)).toBe("live");
    expect(applyBudget("live", 99999, -1)).toBe("live");
  });

  it("已是 replay → 保持 replay（不升级！）", () => {
    // 预算没花完也不能把 replay 升回 live——replay 是显式/无 key 的选择
    expect(applyBudget("replay", 0, 20)).toBe("replay");
  });
});

describe("resolveMode（无 key 自动 replay）", () => {
  it("无 key → replay；有 key → live；显式模式优先", () => {
    expect(resolveMode({})).toBe("replay");
    expect(resolveMode({ LLM_API_KEY: "k" })).toBe("live");
    expect(resolveMode({ LLM_API_KEY: "k", LLM_MODE: "replay" })).toBe("replay");
  });
});
