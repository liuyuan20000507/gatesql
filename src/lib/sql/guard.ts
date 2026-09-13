/**
 * SQL 安全检查（本文件由作者本人手写 —— 面试必问，见 CLAUDE.md）。
 *
 * AI 建立本文件的接口契约与测试；作者实现以下两件事：
 *
 * 1. openReadOnlyConnection —— 连接层（第 1 层）+ 引擎层 authorizer（第 2 层）
 * 2. guardSql —— 语句层白名单（第 4 层，fail-closed）
 *
 * 参考 docs/07-security.md 的「第 1/2/4 层」「自测攻击清单」。
 * 测试在 tests/security/guard.test.ts，绿了就对了。
 */

import { DatabaseSync } from "node:sqlite";

/* ------------------------------------------------------------------ */
/* 对外类型（消费方：executor.ts / loop.ts / route.ts，勿改签名）       */
/* ------------------------------------------------------------------ */

export type GuardReason =
  /** 正则预检：出现分号暗示的多语句迹象（正常 SQL 不应有裸分号之外的情况） */
  | "PATTERN_SEMICOLON"
  /** 语句不以 SELECT / WITH 开头 */
  | "NOT_SELECT_OR_WITH"
  /** AST 解析失败 —— fail-closed，一律拒绝 */
  | "AST_PARSE_FAILED"
  /** AST 中检出危险节点（写操作 / 多语句 / PRAGMA / ATTACH / 系统表） */
  | "DANGEROUS_NODE"
  /** authorizer 在 prepare 阶段拒绝（含表白名单外的表） */
  | "AUTHORIZER_REJECTED";

export type GuardVerdict =
  | { ok: true; sql: string } // 通过；sql 为已注入/收紧 LIMIT 的最终语句
  | { ok: false; reason: GuardReason; detail?: string };

/* ------------------------------------------------------------------ */
/* 第 1+2 层：只读连接 + 引擎级授权回调                                */
/* ------------------------------------------------------------------ */

/**
 * 以只读模式打开被分析库，并安装授权回调。
 *
 * 需要你实现的要点（docs/07-security.md 第 1、2 层）：
 * - { readOnly: true }（不要用 immutable=1 —— 重新 seed 后长连接会读脏页）
 * - setAuthorizer 回调：prepare 阶段拿到 (action, catalog, table, col, arg)，
 *   READ/SELECT/FUNCTION 返回 1（放行）；INSERT/UPDATE/DELETE/DROP/ALTER/
 *   ATTACH/DETACH/PRAGMA/CREATE 返回 0（拒绝）；再按「表名白名单」
 *   挡掉 sqlite_master 与 _column_comments（schema 由应用层喂，不允许自查）。
 *   回调做的是编译期闸门，不做超时/行数限制。
 */
export function openReadOnlyConnection(dbPath: string): DatabaseSync {
  throw new Error("guard.ts 的 openReadOnlyConnection 由作者实现");
}

/* ------------------------------------------------------------------ */
/* 第 4 层：语句层 AST 白名单（fail-closed）                           */
/* ------------------------------------------------------------------ */

/**
 * 语句级防护。返回 { ok: false } 时调用方不得执行，且不重试模型。
 *
 * 需要你实现的要点（docs/07-security.md 第 4 层，作者已配 node-sql-parser）：
 * 1. 正则预检（廉价前置）：非 SELECT/WITH 开头、含若隐若现的多语句迹象 → 拒
 * 2. 用 new Parser().astify(sql) 解析；解析失败一律拒绝（AST_PARSE_FAILED）
 * 3. 只允许 SINGLE 语句（不能是多语句数组）；语句类型只允许 SELECT / WITH
 * 4. 危险节点扫描：INSERT/UPDATE/DELETE/DROP/ALTER/PRAGMA/ATTACH/EXECUTE 等
 *    —— 包括藏在 CTE、子查询里的（node 类型树里逐层查）
 * 5. LIMIT 注入/收紧：无 LIMIT 则 AST 改写成尾部加 LIMIT 1000 后重新生成 SQL；
 *    有 LIMIT 则数值收紧到 ≤ 1000（numberic 常量比较即可）
 * 6. 通过后返回改写后的完整 SQL 文本（用 ast 重建或字符串拼接，自行选）
 *
 * 任何一层拒绝都要在 detail 里给人类可读的中文理由（前端会展示）。
 */
export function guardSql(rawSql: string): GuardVerdict {
  throw new Error("guard.ts 的 guardSql 由作者实现");
}