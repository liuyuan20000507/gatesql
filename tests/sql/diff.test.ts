import { describe, expect, it } from "vitest";

import { wordDiff } from "@/lib/sql/diff";

describe("wordDiff", () => {
  it("完全相同 → 双栏全 same，无增删", () => {
    const d = wordDiff("SELECT a FROM t", "SELECT a FROM t");
    expect(d.left).toEqual([{ text: "SELECT a FROM t", kind: "same" }]);
    expect(d.right).toEqual([{ text: "SELECT a FROM t", kind: "same" }]);
  });

  it("中段插入 WHERE 谓词 → 右栏标 ins，左栏无该段", () => {
    const d = wordDiff("SELECT sum(amount) FROM t LIMIT 10", "SELECT sum(amount) FROM t WHERE status = 'x' LIMIT 10");
    const ins = d.right.filter((s) => s.kind === "ins");
    expect(ins.length).toBeGreaterThan(0);
    expect(ins.map((s) => s.text).join("")).toContain("WHERE");
    expect(d.left.some((s) => s.kind === "ins")).toBe(false);
  });

  it("替换词 → 左栏 del 旧词、右栏 ins 新词（词为最小单位）", () => {
    const d = wordDiff("SUM(p.price) AS x", "SUM(oi.unit_price) AS x");
    expect(d.left.some((s) => s.kind === "del" && s.text.includes("p.price"))).toBe(true);
    expect(d.right.some((s) => s.kind === "ins" && s.text.includes("oi.unit_price"))).toBe(true);
    expect(d.right.some((s) => s.kind === "same" && s.text.includes("AS"))).toBe(true);
  });

  it("空 prev（首次）→ 右栏整体 ins", () => {
    const d = wordDiff("", "SELECT 1");
    expect(d.right.every((s) => s.kind === "ins")).toBe(true);
  });
});
