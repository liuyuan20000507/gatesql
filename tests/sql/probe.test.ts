import { describe, expect, it } from "vitest";

import { buildEmptyResultProbes, splitWhere } from "@/lib/sql/probe";

// 模仿 guard.sqlify 重建后的形态：反引号标识符、单行、LIMIT 在尾部
const THREE =
  "SELECT SUM(`oi`.`amount`) AS `total` FROM `order_items` AS `oi` INNER JOIN `orders` AS `o` ON `oi`.`order_id` = `o`.`id` " +
  "WHERE `o`.`status` = '已完成' AND `o`.`created_at` BETWEEN '2027-01-01' AND '2027-01-31' AND `c`.`region` = '华东' LIMIT 1000";

describe("buildEmptyResultProbes（5E 归因探针）", () => {
  it("BETWEEN 的两个 AND 只算一个条件：放宽时间不留半截谓词", () => {
    const w = splitWhere(THREE);
    expect(w?.conds.length).toBe(3);
    const time = buildEmptyResultProbes(THREE).find((p) => p.label === "时间范围");
    expect(time).toBeDefined();
    expect(time!.sql).not.toContain("created_at");
    expect(time!.sql).not.toMatch(/AND\s+'2027-01-31'/); // 半截 BETWEEN 尾巴
    expect(time!.sql).toContain("`o`.`status` = '已完成'");
  });

  it("聚合无 GROUP BY 的探针直接数底表行：SELECT 列表换成 COUNT(*)", () => {
    const probes = buildEmptyResultProbes(THREE);
    expect(probes.every((p) => p.sql.startsWith("SELECT COUNT(*) AS probe_count FROM"))).toBe(true);
    const time = probes[0];
    expect(time.sql).not.toContain("SUM(");
  });

  it("带 GROUP BY 的查询用包层 COUNT（数列数）", () => {
    const sql = "SELECT p.category, SUM(oi.amount) AS s FROM order_items oi JOIN products p ON p.id = oi.product_id JOIN orders o ON o.id = oi.order_id WHERE o.status = '已完成' GROUP BY p.category";
    const probes = buildEmptyResultProbes(sql);
    expect(probes[0].sql).toContain("FROM (");
  });

  it("三类条件齐全 → 时间/状态/可空列 + 兜底全部，共 4 条", () => {
    const probes = buildEmptyResultProbes(THREE);
    expect(probes.map((p) => p.label)).toEqual([
      "时间范围",
      "订单状态过滤",
      "可空列等值过滤（region/channel）",
      "全部过滤条件",
    ]);
  });

  it("单条件 SQL 不生成重复的「全部」兜底", () => {
    const sql = "SELECT COUNT(*) AS n FROM orders WHERE status = '已完成'";
    expect(buildEmptyResultProbes(sql).map((p) => p.label)).toEqual(["订单状态过滤"]);
  });

  it("全部放宽：去掉整个 WHERE 但保留 LIMIT", () => {
    const sql = "SELECT COUNT(*) AS n FROM orders WHERE status = '已完成' AND created_at >= '2027-01-01'";
    const probes = buildEmptyResultProbes(sql);
    const all = probes[probes.length - 1];
    expect(all.label).toBe("全部过滤条件");
    expect(all.sql).not.toMatch(/WHERE `?status/i);
    expect(all.sql).toContain("FROM orders");
  });

  it("无 WHERE → 无可放宽，返回空", () => {
    expect(buildEmptyResultProbes("SELECT COUNT(*) AS n FROM customers")).toEqual([]);
  });

  it("OR 括号组不被误拆（可空列条件被正确识别为独立一条）", () => {
    const sql = "SELECT 1 FROM orders WHERE (`c`.`region` = '华东' OR `c`.`region` = '华南') AND `o`.`status` = '已完成'";
    const probes = buildEmptyResultProbes(sql);
    expect(probes.map((p) => p.label)).toContain("可空列等值过滤（region/channel）");
  });
});
