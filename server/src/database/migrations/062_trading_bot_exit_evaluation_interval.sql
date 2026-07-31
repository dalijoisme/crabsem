-- Exit Evaluation Interval sprint: decouples exit checks from the BUY-side
-- scan_interval_seconds cadence. Every existing row gets the 5s default -
-- scheduler/exitEvaluationScheduler.js falls back to 5 when this column is
-- somehow null (pre-migration in-memory config), but a real column default
-- means that fallback should never actually be needed.

ALTER TABLE trading_bot_config ADD COLUMN exit_evaluation_interval_seconds INTEGER NOT NULL DEFAULT 5;
