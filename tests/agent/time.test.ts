import { describe, expect, it } from "vitest";

import { resolveTimeRange } from "@/lib/agent/time";

const AS_OF = "2026-08-31";

describe("resolveTimeRange（步骤 1 时间归一）", () => {
  it("年月日 → 单日区间，改写文本收敛为单个日期（6C 实测 bug 回归）", () => {
    const r = resolveTimeRange("2026 年 8 月 5 日的已完成订单销售额", AS_OF);
    expect(r).not.toBeNull();
    expect(r!.from).toBe("2026-08-05");
    expect(r!.to).toBe("2026-08-05");
    // 修复前的 bug：年月规则吃掉「2026 年 8 月」，改写文本残留「5 日」
    expect(r!.rewrittenQuestion).toContain("2026-08-05");
    expect(r!.rewrittenQuestion).not.toContain("5 日");
  });

  it("ISO 日期 → 单日区间", () => {
    const r = resolveTimeRange("2026-08-05 当天卖了多少", AS_OF);
    expect(r!.from).toBe("2026-08-05");
    expect(r!.to).toBe("2026-08-05");
  });

  it("「2026 年 8 月」后不跟日 → 仍解析为整月（不受新规则影响）", () => {
    const r = resolveTimeRange("2026 年 8 月的销售额", AS_OF);
    expect(r!.from).toBe("2026-08-01");
    expect(r!.to).toBe("2026-08-31");
  });

  it("相对表达不受影响：上个月", () => {
    const r = resolveTimeRange("上个月的销售额", AS_OF);
    expect(r!.from).toBe("2026-07-01");
    expect(r!.to).toBe("2026-07-31");
  });

  it("无时间表达 → null", () => {
    expect(resolveTimeRange("有多少客户下过单", AS_OF)).toBeNull();
  });

  it("「X 至 X」式的改写不会出现在多日区间上", () => {
    const r = resolveTimeRange("近 30 天的销售额", AS_OF);
    expect(r!.display).toBe("2026-08-02 ~ 2026-08-31");
    expect(r!.rewrittenQuestion).toContain("2026-08-02 至 2026-08-31");
  });
});
