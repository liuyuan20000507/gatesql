/**
 * 8 条业务口径规则的纯数据声明。
 *
 * 消费方：
 *   - lint.ts          —— 谓词到达性检查（fail-open）
 *   - loop.ts（手写）   —— 把规则的中文描述注入系统提示词
 *   - receipt.ts        —— 口径回执卡片的翻译范围
 *   - tests/rules/      —— 每条的 trigger / nonTrigger fixture
 *
 * 设计约束：规则必须是数据，不是代码 —— 每条规则都能独立
 * 「加一条」/「降级一条」而不动 lint 主逻辑。误报率超 5% 的规则
 * 降级为 warn 或删除（见 docs/06-evaluation.md）。
 */

import { z } from "zod";

import { getConfig } from "@/lib/env";
import type { RuleId } from "@/lib/events";

/** 严重级别：block = 不执行、回喂重生成；warn = 继续执行但答案降级「未核验」 */
export const RuleLevelSchema = z.enum(["block", "warn"]);

export interface CaliberRule {
  id: RuleId;
  level: "block" | "warn";
  /** 简短名称 */
  name: string;
  /** 中文描述 —— 原样注入系统提示词（<400 token 合计） */
  description: string;
  /** 反面示范 —— 一起注入提示词 */
  negativeExample: string;
  /**
   * 正交 fixture（TDD）：
   *   trigger    —— 一条必然触发本规则的 SQL
   *   nonTrigger —— 一条语义正确、绝不触发本规则的 SQL（防误报）
   * 新规则必须配齐这两条才能合并。
   */
  fixture: { trigger: string; nonTrigger: string };
}

/**
 * 顺序即优先级。lint 输出按此顺序排列。
 * 命名空间是固定的：金额聚合 / 订单量 / 可空列 / 时效性 / 排序截断 /
 * 多表连接 —— 新增规则不要越过这六个维度（跨越意味着换个维度做产品）。
 */
export const RULES: readonly CaliberRule[] = [
  {
    id: "R1",
    level: "block",
    name: "金额类聚合必须约束订单状态",
    description:
      "对 order_items.amount 或 unit_price 做 SUM/AVG 等金额聚合时，WHERE 或 JOIN ON 链路上必须约束 orders.status = '已完成'；已取消(1873)和已退款(2017)订单不计入金额。",
    negativeExample: "SELECT SUM(oi.amount) FROM order_items oi JOIN orders o ... （无 o.status = '已完成'）",
    fixture: {
      trigger: "SELECT SUM(amount) FROM order_items oi JOIN orders o ON o.id = oi.order_id",
      nonTrigger: "SELECT SUM(oi.amount) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = '已完成'",
    },
  },
  {
    id: "R2",
    level: "block",
    name: "金额必须取 order_items.unit_price，不得用 products.price",
    description:
      "明细行的成交单价是 order_items.unit_price（可能因促销低于标价）；凡引用了 products.price 参与金额计算即为违规，应换成 unit_price。",
    negativeExample: "SELECT SUM(oi.quantity * p.price) FROM order_items oi JOIN products p ...",
    fixture: {
      trigger: "SELECT SUM(oi.quantity * p.price) FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE p.category = '食品生鲜'",
      nonTrigger: "SELECT SUM(oi.amount) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = '已完成'",
    },
  },
  {
    id: "R3",
    level: "block",
    name: "涉及 order_items 的连接后，订单量必须 COUNT(DISTINCT orders.id)",
    description:
      "orders 与 order_items 是一对多；访问了 order_items 后对订单数计数必须去重，否则 JOIN 扇出会把一笔多明细订单算成多笔。",
    negativeExample: "SELECT COUNT(o.id) FROM orders o JOIN order_items oi ON oi.order_id = o.id",
    fixture: {
      trigger: "SELECT o.channel, COUNT(o.id) FROM orders o JOIN order_items oi ON oi.order_id = o.id GROUP BY o.channel",
      nonTrigger: "SELECT COUNT(DISTINCT o.id) FROM orders o JOIN order_items oi ON oi.order_id = o.id",
    },
  },
  {
    id: "R4",
    level: "warn",
    name: "按可空列 GROUP BY 必须显式处理 NULL",
    description:
      "orders.channel 有 3070 个 NULL、customers.region 有 94 个 NULL；按这些列分组时若不加 COALESCE(列,'未知') 或显式条件，NULL 组会静默消失。命中按 warn 处理（答案降级未核验）。",
    negativeExample: "SELECT region, COUNT(*) FROM customers GROUP BY region",
    fixture: {
      trigger: "SELECT region, COUNT(*) FROM customers GROUP BY region",
      nonTrigger: "SELECT COALESCE(region, '未知') AS region, COUNT(*) FROM customers GROUP BY region",
    },
  },
  {
    id: "R5",
    level: "block",
    name: "毛利必须用 unit_price - cost",
    description:
      "毛利 = Σ((unit_price - cost) × quantity)；units 用成交价而不是标价。出现 price - cost 或 cost 与标价混用的形如 (p.price - p.cost) 表达式即为违规。",
    negativeExample: "SELECT category, SUM((p.price - p.cost) * oi.quantity) FROM ...",
    fixture: {
      trigger: "SELECT p.category, SUM((p.price - p.cost) * oi.quantity) FROM products p JOIN order_items oi ON p.id = oi.product_id",
      nonTrigger: "SELECT p.category, SUM((oi.unit_price - p.cost) * oi.quantity) FROM order_items oi JOIN products p ON p.id = oi.product_id JOIN orders o ON o.id = oi.order_id WHERE o.status = '已完成'",
    },
  },
  {
    id: "R6",
    level: "warn",
    name: "趋势/对比类查询必须带时间限定",
    description:
      "涉及月/季/年度时间维度、或问题中出现趋势类表达时，SQL 必须包含 orders.created_at 上的范围条件；否则会按全时段计算。命中按 warn 处理。",
    negativeExample: "SELECT substr(created_at,1,7) m, SUM(amount) ... （无 WHERE/时间范围）",
    fixture: {
      trigger: "SELECT p.category, SUM(oi.amount) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = '已完成' GROUP BY p.category",
      nonTrigger: "SELECT p.category, SUM(oi.amount) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = '已完成' AND o.created_at >= '2026-01-01' AND o.created_at < '2026-07-01' GROUP BY p.category",
    },
  },
  {
    id: "R7",
    level: "warn",
    name: "排行榜类必须 ORDER BY + LIMIT",
    description:
      "问题含「最 / 前 N / 排名」等表达时，SQL 必须有 ORDER BY 和恰当的 LIMIT；否则返回全量无序数据。命中按 warn 处理。",
    negativeExample: "SELECT name FROM products ORDER BY price DESC（无 LIMIT）/ SELECT name ... LIMIT 5（无 ORDER BY）",
    fixture: {
      trigger: "SELECT p.name, SUM(oi.amount) AS revenue FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id WHERE o.status = '已完成' GROUP BY p.name LIMIT 5",
      nonTrigger: "SELECT p.name, SUM(oi.amount) AS revenue FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id WHERE o.status = '已完成' GROUP BY p.name ORDER BY revenue DESC LIMIT 5",
    },
  },
  {
    id: "R8",
    level: "block",
    name: "多表查询必须在连接条件上构成可达链",
    description:
      "FROM 出现多张表时，JOIN ON / 等值条件必须使全部表连通（无条件的笛卡尔积拒绝）。判定范围为 FROM + JOIN 子句；条件出现在 WHERE 的隐式连接（'... , o WHERE o.id = oi.order_id'）应视为可达。",
    negativeExample: "SELECT COUNT(*) FROM orders, order_items, customers（无任何连接条件）",
    fixture: {
      trigger: "SELECT COUNT(*) FROM orders, order_items, customers",
      nonTrigger: "SELECT COUNT(*) FROM orders, order_items, customers WHERE orders.id = order_items.order_id AND orders.customer_id = customers.id",
    },
  },
];

export const RULES_BY_ID: ReadonlyMap<RuleId, CaliberRule> = new Map(
  RULES.map((rule) => [rule.id, rule]),
);

/** 注入提示词的紧凑中文清单（合计应 < 400 token） */
export function rulesPromptText(): string {
  // A/B 开关（docs/08 第 4 周）：off 时返回空串 —— 量化规则文本注入对 D 层的价值。
  // 开关放这里而不是 loop.ts：受保护文件不动，且所有消费方行为一致
  if (getConfig().RULES_INJECTION === "off") return "";
  return RULES.map((r) => `- 规则 ${r.id}（${r.level === "block" ? "强制" : "注意"}）：${r.description}`).join("\n");
}