/**
 * 结果等价比对器（docs/06-evaluation.md 第三节）。
 *
 * 评测只比执行结果，不比 SQL 文本 —— 同一问题有无数种正确写法。
 * 规则（每条都有单测，见 tests/eval/compare.test.ts）：
 *   - 列投影：gold 的列按名字对齐到 agent 的列（精确 → 包含 → 数量相等时按下标）。
 *     agent 多给的说明列不参与比较 —— 基线 #1 实测 3 道题因多给列被误判（C3/F1/F3），
 *     而真实产品里多给上下文列是更好的交付，不是错误
 *   - 列序无关
 *   - 行序：由调用方决定（eval 脚本的口径：gold 同时含 ORDER BY 和 LIMIT
 *     —— 即排行榜，名次即语义 —— 才校验行序；普通分组题每行自带键，行序是展示问题）
 *   - 浮点容差：数值四舍五入到 2 位小数后比较（本库金额即 2 位精度）
 *   - int 与 decimal 归一：5 与 5.0 视为相等
 *   - NULL / 0 / 空字符串三者严格判不等
 *
 * ️ 绝不用 JSON.stringify(a) === JSON.stringify(b)：它在浮点尾差、列名不同、
 *    列序、行序、int/decimal、NULL vs 0 上全部误判。一个静默误判的比对器
 *    会让整套准确率变成谎言，后面所有优化决策都建立在噪声上。
 */

export interface ResultSetLike {
  columns: string[];
  rows: readonly (readonly unknown[])[];
}

export interface CompareOptions {
  /** 本次比较是否校验行序（eval 脚本口径：gold 含 ORDER BY + LIMIT 的排行榜题才传 true） */
  ordered: boolean;
}

export interface CompareResult {
  equal: boolean;
  /** 不相等时的人类可读原因（进评测报告，便于定位是哪种差异） */
  reason?: string;
}

/** 数值归一：四舍五入到 2 位小数并去掉多余的 0（等价于 0.01 容差） */
function round2(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** 把任意标量归一成可比较的字符串 token（类型不同则 token 前缀不同） */
function cellToken(value: unknown): string {
  if (value === null || value === undefined) return "∅"; // NULL 独立成一类
  if (typeof value === "bigint") return `n:${round2(Number(value))}`;
  if (typeof value === "number") return Number.isFinite(value) ? `n:${round2(value)}` : `n:${String(value)}`;
  if (typeof value === "boolean") return `b:${value}`;
  if (typeof value === "string") return `s:${value}`;
  return `s:${JSON.stringify(value)}`;
}

/**
 * 列投影映射：gold 的每一列对应 agent 的哪一列。
 *
 * 三级对齐：
 *   1. 列名精确相同（不区分大小写）
 *   2. 名字包含关系（gold "name" ↔ agent "customer_name"）
 *   3. 剩余列数量相等时按下标对齐（兜底 aggregate 自动命名 / 中文别名的场景）
 * 剩余数量不相等则映射失败 —— 此时无法确定 agent 多出来的列哪个是答案。
 */
function buildColumnMapping(goldCols: string[], agentCols: string[]): number[] | null {
  const used = new Set<number>();
  const mapping: Array<number | undefined> = new Array(goldCols.length).fill(undefined);

  for (const pass of ["exact", "contains"] as const) {
    for (let g = 0; g < goldCols.length; g++) {
      if (mapping[g] !== undefined) continue;
      const goldLower = goldCols[g].toLowerCase();
      const idx = agentCols.findIndex((c, i) => {
        if (used.has(i)) return false;
        const agentLower = c.toLowerCase();
        return pass === "exact" ? agentLower === goldLower : agentLower.includes(goldLower) || goldLower.includes(agentLower);
      });
      if (idx !== -1) {
        mapping[g] = idx;
        used.add(idx);
      }
    }
  }

  const unmatchedGold = goldCols.map((_, i) => i).filter((i) => mapping[i] === undefined);
  const unusedAgent = agentCols.map((_, i) => i).filter((i) => !used.has(i));
  // agent 多出来的列合法地没有归属（投影语义）；只有 gold 列找不到归属才需要兜底：
  // 剩余数量相等时按下标对齐，否则无法确定哪列是答案 → 失败
  if (unmatchedGold.length > 0 && unmatchedGold.length !== unusedAgent.length) return null;
  unmatchedGold.forEach((g, k) => {
    mapping[g] = unusedAgent[k];
  });
  return mapping as number[];
}

function rowKey(row: readonly unknown[], idxs: number[]): string {
  return idxs.map((i) => cellToken(row[i])).join("");
}

/**
 * 比较两个结果集是否等价。
 * @param gold  标准答案的执行结果（用 gold SQL 跑出来的）
 * @param agent agent 实际交付的结果（取自 rows 事件）
 */
export function resultsEqual(gold: ResultSetLike, agent: ResultSetLike, opts: CompareOptions): CompareResult {
  const mapping = buildColumnMapping(gold.columns, agent.columns);
  if (!mapping) {
    return {
      equal: false,
      reason: `列无法对齐：gold ${gold.columns.length} 列 [${gold.columns.join(", ")}]，agent ${agent.columns.length} 列 [${agent.columns.join(", ")}]（列数不同且无法按名字对齐）`,
    };
  }

  if (gold.rows.length !== agent.rows.length) {
    return {
      equal: false,
      reason: `行数不同：gold ${gold.rows.length} 行，agent ${agent.rows.length} 行（若 agent 明显偏少，可能是被 LIMIT 截断或筛选条件过严）`,
    };
  }

  // gold 行按自身列序取值；agent 行按映射后的列序取值
  // （mapping[j] = 与 gold 第 j 列对应的 agent 列下标）
  const goldIdxs = gold.columns.map((_, i) => i);

  if (opts.ordered) {
    for (let i = 0; i < gold.rows.length; i++) {
      if (rowKey(gold.rows[i], goldIdxs) !== rowKey(agent.rows[i], mapping)) {
        return { equal: false, reason: `第 ${i + 1} 行内容不同（gold 带 ORDER BY，故校验行序）` };
      }
    }
    return { equal: true };
  }

  // 无序比较：把两边都折叠成「行 token 的多重集」再比
  const goldKeys = gold.rows.map((r) => rowKey(r, goldIdxs)).sort();
  const agentKeys = agent.rows.map((r) => rowKey(r, mapping)).sort();
  for (let i = 0; i < goldKeys.length; i++) {
    if (goldKeys[i] !== agentKeys[i]) {
      return { equal: false, reason: `行内容集合不同（第 ${i + 1} 个元素不匹配；行序不参与比较）` };
    }
  }
  return { equal: true };
}