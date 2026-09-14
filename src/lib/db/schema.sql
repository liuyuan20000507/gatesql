-- app.db 的建表语句（应用自身的库：trace / 报表 / 纠正样本 / 评测记录）。
-- 第 2 周一次定死；改结构 = 删文件重建（见 docs/04-data-model.md）。

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  question       TEXT NOT NULL,
  as_of_date     TEXT NOT NULL,
  verdict        TEXT,                -- verified / unverified / refused
  verdict_reasons TEXT,               -- JSON 数组
  final_status   TEXT,                -- ok / 各 error code / aborted
  attempts       INTEGER DEFAULT 0,
  llm_calls      INTEGER DEFAULT 0,
  input_tokens   INTEGER DEFAULT 0,
  output_tokens  INTEGER DEFAULT 0,
  cost_cny       REAL DEFAULT 0,
  elapsed_ms     INTEGER DEFAULT 0,
  llm_mode       TEXT,                -- live / record / replay
  user_feedback  TEXT,                -- good / bad / NULL
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,           -- llm_call / sql_attempt / guard / lint / eqp / execute / verify / receipt
  started_at INTEGER,
  ended_at   INTEGER,
  status     TEXT,                    -- ok / rejected / failed
  attributes TEXT                     -- JSON，按 kind 不同结构
);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);

CREATE TABLE IF NOT EXISTS events (
  run_id  TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  type    TEXT NOT NULL,
  payload TEXT NOT NULL,              -- 事件完整 JSON（含 type）
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  sql           TEXT NOT NULL,
  chart_spec    TEXT,                 -- JSON
  source_run_id TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS corrections (
  id                TEXT PRIMARY KEY,
  question          TEXT NOT NULL,
  sql               TEXT NOT NULL,
  tables            TEXT,             -- JSON 数组
  keywords          TEXT,             -- JSON 数组
  enabled           INTEGER DEFAULT 1,
  verified_by_user  INTEGER DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id                TEXT PRIMARY KEY,
  ran_at            TEXT NOT NULL,
  model             TEXT NOT NULL,
  llm_mode          TEXT NOT NULL,
  total             INTEGER NOT NULL,
  passed            INTEGER NOT NULL,
  accuracy          REAL NOT NULL,
  refusal_rate      REAL NOT NULL,
  overconfident_rate REAL NOT NULL,
  avg_attempts      REAL NOT NULL,
  avg_elapsed_ms    REAL NOT NULL,
  total_input_tokens  INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  commit_hash       TEXT
);

CREATE TABLE IF NOT EXISTS eval_items (
  eval_run_id   TEXT NOT NULL,
  question_id   TEXT NOT NULL,
  layer         TEXT NOT NULL,
  passed        INTEGER NOT NULL,     -- 0/1
  agent_verdict TEXT,                 -- verified / unverified / refused / NULL(未出 state)
  gold_expected TEXT NOT NULL,        -- answered / refused
  attempts      INTEGER,
  elapsed_ms    INTEGER,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  fail_reason   TEXT,
  PRIMARY KEY (eval_run_id, question_id)
);