/**
 * lint.ts 的验收测试。
 *
 * 以 rules.ts 里每条规则的正交 fixture 为准：
 *   trigger 必须产出对应规则 id 的违规；
 *   nonTrigger 不得产出该规则 id 的违规（防误报）。
 */

import { describe, expect, it } from "vitest";

import { lintRules, type LintHints } from "@/lib/sql/lint";
import { RULES } from "@/lib/sql/rules";

const NO_HINTS: LintHints = { timeKeywords: [], rankKeywords: [] };

/** R6/R7 需要结合问题侧提示词才能判定 */
const HINTS_BY_RULE: Partial<Record<string, LintHints>> = {
  R6: { timeKeywords: ["近30天", "趋势"], rankKeywords: [] },
  R7: { timeKeywords: [], rankKeywords: ["最", "前5", "排名"] },
};

describe("8 条口径规则的 trigger / nonTrigger", () => {
  for (const rule of RULES) {
    const hints = HINTS_BY_RULE[rule.id];

    it(`${rule.id} ${rule.name} —— trigger 触发`, () => {
      const report = lintRules(rule.fixture.trigger, hints);
      expect(report.parseFailed).toBe(false);
      expect(report.violations.map((v) => v.ruleId)).toContain(rule.id);
    });

    it(`${rule.id} ${rule.name} —— nonTrigger 不误报`, () => {
      const report = lintRules(rule.fixture.nonTrigger, hints);
      expect(report.violations.map((v) => v.ruleId)).not.toContain(rule.id);
    });
  }
});

describe("lint 的 fail-open 行为", () => {
  it("解析失败的 SQL 返回 parseFailed，而不是抛错", () => {
    const report = lintRules("SELECT FROM WHERE (语法坏掉了", NO_HINTS);
    expect(report.parseFailed).toBe(true);
    expect(report.violations).toHaveLength(0);
  });
});

describe("R1 的细节：状态谓词以别名出现也认得出", () => {
  it("o.status = '已完成' 通过别名 o 命中", () => {
    const sql = "SELECT SUM(oi.amount) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = '已完成'";
    const report = lintRules(sql, NO_HINTS);
    expect(report.violations.map((v) => v.ruleId)).not.toContain("R1");
  });

  it("guard.sqlify 重建后的反引号标识符不误报（改自真实 trace 的误报）", () => {
    // guard 会把这句（正确 SQL，用反引号）交给 lint：
    const sql =
      "SELECT SUM(`oi`.`amount`) AS `total_sales` FROM `order_items` AS `oi` INNER JOIN `orders` AS `o` ON `oi`.`order_id` = `o`.`id` WHERE `o`.`status` = '已完成' LIMIT 1000";
    const report = lintRules(sql, NO_HINTS);
    expect(report.violations.map((v) => v.ruleId)).not.toContain("R1");
  });
});