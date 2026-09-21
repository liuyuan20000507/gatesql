import { describe, expect, it } from "vitest";

import {
  buildChartPrompts,
  buildSelfCheckPrompts,
  buildSqlGenSystemPrompt,
  buildSqlGenUserParts,
} from "@/lib/agent/prompt";

describe("buildSqlGenSystemPrompt（cassette 键稳定性）", () => {
  it("无 few-shot 时以卡片结尾，不含多余段", () => {
    const s = buildSqlGenSystemPrompt("CARD_TEXT", null);
    expect(s.endsWith("CARD_TEXT")).toBe(true);
    expect(s).toContain("【输出契约】");
    expect(s).toContain("你是 GateSQL 的 SQL 生成引擎");
  });

  it("few-shot 追加在卡片之后", () => {
    const s = buildSqlGenSystemPrompt("CARD_TEXT", "FEWSHOT");
    expect(s.endsWith("CARD_TEXT\nFEWSHOT")).toBe(true);
  });
});

describe("buildSqlGenUserParts（重试上下文，eval 全一稿过覆盖不到——直接测）", () => {
  it("首次尝试：只有问题，无失败历史", () => {
    const parts = buildSqlGenUserParts("Q?", [], false);
    expect(parts).toEqual(["问题：Q?"]);
  });

  it("带失败历史：结构化摘要逐条列出（不重贴 schema 卡片）", () => {
    const parts = buildSqlGenUserParts("Q?", [{ attempt: 1, kind: "RULE_VIOLATION", detail: "缺 status" }], false);
    expect(parts[0]).toBe("问题：Q?");
    expect(parts.join("\n")).toContain("第 1 次：RULE_VIOLATION —— 缺 status");
    expect(parts.join("\n")).not.toContain("表结构");
  });

  it("指纹警告在命中后追加", () => {
    const parts = buildSqlGenUserParts("Q?", [], true);
    expect(parts[parts.length - 1]).toContain("等价于没改");
  });
});

describe("buildSelfCheckPrompts / buildChartPrompts", () => {
  it("自检提示含候选 SQL 与五项核对", () => {
    const { user } = buildSelfCheckPrompts("CARD", "Q?", "SELECT 1");
    expect(user).toContain("候选 SQL：SELECT 1");
    expect(user).toContain("表结构：\nCARD");
  });

  it("图表 content 只喂前 50 行（上下文有界）", () => {
    const rows = Array.from({ length: 80 }, (_, i) => [i]);
    const { user } = buildChartPrompts("CARD", ["n"], rows);
    expect(user).toContain("前 50 行");
    expect(user).not.toContain("\n79\n"); // 第 80 行不应出现
    expect(user.split("\n").filter((l) => /^\d+$/.test(l)).length).toBe(50);
  });

  it("图表 system 强制结论禁数字", () => {
    const { system } = buildChartPrompts("CARD", ["n"], []);
    expect(system).toContain("禁止出现任何数字");
  });
});
