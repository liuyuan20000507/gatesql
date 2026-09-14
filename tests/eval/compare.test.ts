/**
 * 结果等价比对器的单测。
 *
 * 这个文件的价值：比对器一旦静默误判，整套准确率就是谎言。
 * 所以六类「最容易误判」的差异必须逐条钉死。
 */

import { describe, expect, it } from "vitest";

import { resultsEqual, type ResultSetLike } from "@/lib/eval/compare";

const unordered = { ordered: false };
const ordered = { ordered: true };

describe("列名与列序", () => {
  it("列名不同、顺序相同 → 相等（按下标对齐）", () => {
    const gold: ResultSetLike = { columns: ["COUNT(*)"], rows: [[500]] };
    const agent: ResultSetLike = { columns: ["n"], rows: [[500]] };
    expect(resultsEqual(gold, agent, unordered).equal).toBe(true);
  });

  it("列名相同但列序不同 → 相等（按名字对齐）", () => {
    const gold: ResultSetLike = {
      columns: ["category", "revenue"],
      rows: [["手机数码", 100], ["电脑办公", 80]],
    };
    const agent: ResultSetLike = {
      columns: ["revenue", "category"],
      rows: [[100, "手机数码"], [80, "电脑办公"]],
    };
    expect(resultsEqual(gold, agent, unordered).equal).toBe(true);
  });

  it("agent 多给说明列，但 gold 列能按名字对齐 → 相等（列投影；F1/F3 基线误判的修复）", () => {
    const gold: ResultSetLike = { columns: ["name", "total_spent"], rows: [["何明", 147531.97]] };
    const agent: ResultSetLike = {
      columns: ["customer_id", "customer_name", "total_spent"],
      rows: [[324, "何明", 147531.97]],
    };
    expect(resultsEqual(gold, agent, unordered).equal).toBe(true);
  });

  it("agent 多给列且列名对不上（中文别名 + 列数不同）→ 不相等（无法确定哪列是答案）", () => {
    const gold: ResultSetLike = { columns: ["level", "avg_order_value"], rows: [["普通", 5088.94]] };
    const agent: ResultSetLike = {
      columns: ["会员等级", "客单价", "已完成销售额", "去重订单数"],
      rows: [["普通", 5088.94, 20803587.9, 4088]],
    };
    const r = resultsEqual(gold, agent, unordered);
    expect(r.equal).toBe(false);
    expect(r.reason).toContain("列无法对齐");
  });

  it("列数不同 → 不相等，且原因里带列名方便定位", () => {
    const r = resultsEqual({ columns: ["a", "b"], rows: [[1, 2]] }, { columns: ["a"], rows: [[1]] }, unordered);
    expect(r.equal).toBe(false);
    expect(r.reason).toContain("列无法对齐");
  });
});

describe("行序", () => {
  const gold: ResultSetLike = { columns: ["name"], rows: [["A"], ["B"], ["C"]] };
  const shuffled: ResultSetLike = { columns: ["name"], rows: [["C"], ["A"], ["B"]] };

  it("gold 无 ORDER BY → 行序不参与比较（打乱仍相等）", () => {
    expect(resultsEqual(gold, shuffled, unordered).equal).toBe(true);
  });

  it("gold 有 ORDER BY → 行序必须一致（打乱即不等）", () => {
    const r = resultsEqual(gold, shuffled, ordered);
    expect(r.equal).toBe(false);
    expect(r.reason).toContain("行序");
  });

  it("有 ORDER BY 且顺序一致 → 相等", () => {
    expect(resultsEqual(gold, { columns: ["name"], rows: [["A"], ["B"], ["C"]] }, ordered).equal).toBe(true);
  });
});

describe("数值归一", () => {
  it("浮点尾差算相等（0.1+0.2 vs 0.3）", () => {
    const gold: ResultSetLike = { columns: ["v"], rows: [[0.1 + 0.2]] };
    const agent: ResultSetLike = { columns: ["v"], rows: [[0.3]] };
    expect(resultsEqual(gold, agent, unordered).equal).toBe(true);
  });

  it("int 与 decimal 归一（500 vs 500.0）", () => {
    expect(resultsEqual({ columns: ["n"], rows: [[500]] }, { columns: ["n"], rows: [[500.0]] }, unordered).equal).toBe(true);
  });

  it("bigint 也能比（大整数计数场景）", () => {
    expect(resultsEqual({ columns: ["n"], rows: [[12000]] }, { columns: ["n"], rows: [[BigInt(12000)]] }, unordered).equal).toBe(true);
  });

  it("超出容差的差异判不等（6.2% 那种真错必须被抓到）", () => {
    const gold: ResultSetLike = { columns: ["v"], rows: [[41015358.75]] };
    const agent: ResultSetLike = { columns: ["v"], rows: [[43560642.14]] };
    expect(resultsEqual(gold, agent, unordered).equal).toBe(false);
  });
});

describe("NULL / 0 / 空串 严格区分", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["NULL vs 0", null, 0],
    ["NULL vs 空串", null, ""],
    ["0 vs 空串", 0, ""],
  ];
  for (const [label, a, b] of cases) {
    it(`${label} → 判不等`, () => {
      expect(resultsEqual({ columns: ["v"], rows: [[a]] }, { columns: ["v"], rows: [[b]] }, unordered).equal).toBe(false);
    });
  }

  it("两边都是 NULL → 相等", () => {
    expect(resultsEqual({ columns: ["v"], rows: [[null]] }, { columns: ["v"], rows: [[null]] }, unordered).equal).toBe(true);
  });
});

describe("行数", () => {
  it("行数不同 → 不相等，且提示可能被截断", () => {
    const gold: ResultSetLike = { columns: ["id"], rows: [[1], [2], [3]] };
    const agent: ResultSetLike = { columns: ["id"], rows: [[1], [2]] };
    const r = resultsEqual(gold, agent, unordered);
    expect(r.equal).toBe(false);
    expect(r.reason).toContain("截断");
  });

  it("多重集语义：重复行也要对齐（两行相同值算相等）", () => {
    const gold: ResultSetLike = { columns: ["v"], rows: [[1], [1]] };
    const agent: ResultSetLike = { columns: ["v"], rows: [[1], [1]] };
    expect(resultsEqual(gold, agent, unordered).equal).toBe(true);
  });

  it("重复行数量不同 → 判不等", () => {
    const gold: ResultSetLike = { columns: ["v"], rows: [[1], [1]] };
    const agent: ResultSetLike = { columns: ["v"], rows: [[1], [2]] };
    expect(resultsEqual(gold, agent, unordered).equal).toBe(false);
  });
});

describe("锚点自检：三个已知数字", () => {
  it("总销售额 41,015,358.75 能被正确识别为相等/不等", () => {
    const gold: ResultSetLike = { columns: ["total"], rows: [[41015358.75]] };
    expect(resultsEqual(gold, { columns: ["total"], rows: [[41015358.75]] }, unordered).equal).toBe(true);
    // 用标价算出来的 43,560,642.14 必须判错
    expect(resultsEqual(gold, { columns: ["total"], rows: [[43560642.14]] }, unordered).equal).toBe(false);
    // 漏掉状态过滤的 60,765,700.25 也必须判错
    expect(resultsEqual(gold, { columns: ["total"], rows: [[60765700.25]] }, unordered).equal).toBe(false);
  });
});