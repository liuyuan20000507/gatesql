/**
 * 无 key 演示模式的预置问题（docs/08 6B）。
 *
 * 每条都满足：在默认配置（所有开关 off/on 如 README）下，其模型调用已有
 * cassette 可放 —— 即不配任何 API key 也能完整跑通。
 * 覆盖：三态（核验/未核验/拒答）、回执真数字、时间回显、NULL 分组、
 * 图表结论、澄清选项、空结果归因。
 * 自愈重试的演示走历史 run 回放页（r_0ac721b1）—— 当前最优配置下
 * 30 题几乎全部一稿通过，现场触发重试反而需要故意问错。
 */

export interface DemoQuestion {
  question: string;
  /** 给观众的一句话看点 */
  highlight: string;
}

export const DEMO_QUESTIONS: DemoQuestion[] = [
  { question: "我们店铺总共卖了多少钱？", highlight: "已核验 + 回执排除计数 1873/2017" },
  { question: "各商品分类的「已完成」销售额分别是多少？", highlight: "图表 + 结论 + 口径过滤" },
  { question: "各下单渠道的「已完成」销售额分别是多少？", highlight: "NULL 渠道以「未知」组出现" },
  { question: "平均每笔订单消费多少钱？", highlight: "JOIN 扇出陷阱：必须 COUNT DISTINCT" },
  { question: "近 30 天的「已完成」销售额是多少？", highlight: "相对时间回显 2026-08-02~08-31" },
  { question: "哪些商品卖得最好？给我一个销量排行榜。", highlight: "销量=件数 + ORDER BY/LIMIT" },
  { question: "客户都分布在哪些地区？", highlight: "未知 94 人：可空列分组" },
  { question: "2027 年 1 月的已完成订单销售额是多少？", highlight: "空结果归因：点名元凶条件" },
  { question: "我们的利润率怎么样？", highlight: "口径歧义 → 拒答 + 三个澄清选项" },
  { question: "员工的平均工资是多少？", highlight: "数据源没有员工表 → 拒答给清单" },
];
