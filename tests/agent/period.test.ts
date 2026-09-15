import { describe, expect, it } from "vitest";

import { detectIncompletePeriod } from "@/lib/agent/period";

const AS_OF = "2026-08-31";

describe("detectIncompletePeriod（5D 不完整周期）", () => {
  it("窗口在水位线之内 → null（如 2026 上半年）", () => {
    expect(detectIncompletePeriod({ from: "2026-01-01", to: "2026-06-30" }, AS_OF)).toBeNull();
  });

  it("窗口越过水位线 → 第一个整月无数据的月份（下半年 → 2026-09）", () => {
    expect(detectIncompletePeriod({ from: "2026-07-01", to: "2026-12-31" }, AS_OF)).toEqual({
      lastPointLabel: "2026-09",
      watermark: AS_OF,
    });
  });

  it("窗口延伸到次年内 → 同样报出（今年全年类问题，从 09 起无数据）", () => {
    const r = detectIncompletePeriod({ from: "2026-01-01", to: "2026-12-31" }, AS_OF);
    expect(r?.lastPointLabel).toBe("2026-09");
  });

  it("窗口只越过同月内几天（截止在窗口月中间）→ 不谎报整月无数据", () => {
    expect(detectIncompletePeriod({ from: "2026-08-01", to: "2026-08-20" }, "2026-08-10")).toBeNull();
  });

  it("无时间窗口（全时段问题）→ null", () => {
    expect(detectIncompletePeriod(null, AS_OF)).toBeNull();
  });
});
