import { describe, expect, it } from "vitest";

import { semanticFingerprint } from "@/lib/sql/fingerprint";

describe("semanticFingerprint（6G⑦：语义归一 + 不过度合并）", () => {
  it("相同 SQL 换空白/大小写 → 同指纹", () => {
    const a = semanticFingerprint("SELECT   o.status FROM orders o WHERE o.status='已完成'");
    const b = semanticFingerprint("select o.status from orders o where o.status='已完成'");
    expect(a).toBe(b);
    expect(a.startsWith("sem:")).toBe(true);
  });

  it("AND 条件换序 → 同指纹（语义等价）", () => {
    const a = semanticFingerprint(
      "SELECT SUM(oi.amount) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status='已完成' AND o.created_at>='2026-08-01'",
    );
    const b = semanticFingerprint(
      "SELECT SUM(oi.amount) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.created_at>='2026-08-01' AND o.status='已完成'",
    );
    expect(a).toBe(b);
  });

  it("别名互换（o→orders 全替换）→ 同指纹", () => {
    const a = semanticFingerprint("SELECT o.status FROM orders o WHERE o.status='已完成'");
    const b = semanticFingerprint("SELECT x.status FROM orders x WHERE x.status='已完成'");
    expect(a).toBe(b);
  });

  it("★过度合并护栏：仅换值（a=1 AND b=2 vs a=2 AND b=1）→ 不同指纹", () => {
    const a = semanticFingerprint("SELECT id FROM orders WHERE status='已完成' AND channel='APP'");
    const b = semanticFingerprint("SELECT id FROM orders WHERE status='APP' AND channel='已完成'");
    expect(a).not.toBe(b);
  });

  it("加了一个条件 → 不同指纹（模型真实改动不被误判）", () => {
    const a = semanticFingerprint("SELECT id FROM orders WHERE status='已完成'");
    const b = semanticFingerprint("SELECT id FROM orders WHERE status='已完成' AND channel='APP'");
    expect(a).not.toBe(b);
  });

  it("SELECT 聚合列不同 → 不同指纹", () => {
    const a = semanticFingerprint("SELECT SUM(amount) FROM order_items");
    const b = semanticFingerprint("SELECT AVG(amount) FROM order_items");
    expect(a).not.toBe(b);
  });

  it("解析失败 → 退回文本指纹（txt: 前缀），绝不误伤", () => {
    const bad = semanticFingerprint("这不是合法的 SQL 碎片 ###");
    expect(bad.startsWith("txt:")).toBe(true);
    // 文本指纹对解析失败的两条仍可比（不同文本 → 不同）
    expect(semanticFingerprint("### junk A")).not.toBe(semanticFingerprint("### junk B"));
  });
});
