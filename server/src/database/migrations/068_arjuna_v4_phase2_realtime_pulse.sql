-- 068_arjuna_v4_phase2_realtime_pulse.sql - Arjuna V4 Phase 2 (Trading
-- Engine Optimization). Three additive changes, all nullable/defaulted so
-- every existing row stays valid with no backfill required. No existing
-- table's existing columns are altered.
--
-- 1. realtime_pulse_snapshots - one row per token per Realtime Pulse
--    computation (chained onto gmgnTrendingScheduler's own 30s collector
--    tick - see services/realtimePulseService.js). This is the durable
--    tier of the poll history (services/realtimePulseBufferService.js
--    holds the in-memory rolling 3-point tier) - it is what makes Pulse
--    survivable across a process restart, queryable for the Daily
--    Trading Review, and debuggable, per the Phase 2 architecture
--    review's own recommendation. Modeled directly on
--    token_price_history's existing append-only shape.
--
-- 2. trading_bot_trades.realtime_pulse_at_entry_json - the computed
--    Realtime Pulse signals (velocity/acceleration/direction/consistency
--    facts, NOT a score) at the moment of BUY, carried through the exact
--    same live.breakdown -> breakdown_json -> buildTradeDatasetFields
--    pipeline every other entry-time fact already uses (see
--    tradeManager.js/tradingBotRepository.js). Purely observational -
--    self-learning dataset completeness (original sprint's Part 4), never
--    read by any live decision path.
--
-- 3. daily_trading_reviews - one real row per real UTC calendar day, same
--    upsert-per-day convention engine_daily_metrics (migration 013)
--    already established. report_json holds the full structured report
--    (trading summary, entry/exit quality, winning/losing patterns,
--    realtime signal statistics, suggested parameter adjustments) - a few
--    flat columns are duplicated out for cheap list-view queries, same
--    "JSON detail + flat summary columns" convention trading_bot_trades
--    already uses for breakdown_json/module_scores_json.

CREATE TABLE IF NOT EXISTS realtime_pulse_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Raw fields, real-time snapshot of gmgn_tokens/gmgn_trenches at THIS
    -- poll - never derived/computed here, computation happens in
    -- services/realtimePulseService.js from a sequence of these rows.
    price REAL,
    liquidity REAL,
    holders INTEGER,
    volume_1h REAL,
    buys_5m INTEGER,
    sells_5m INTEGER,
    price_change_5m REAL,
    price_change_1h REAL,
    net_buy_24h REAL,

    -- Aggregated from gmgn_activity_feed for this token, at this poll -
    -- same real fields smartMoney.js/kol.js already read, aggregated once
    -- per Pulse tick rather than per-candidate (see realtimePulseService.js).
    smart_money_buy_usd REAL,
    smart_money_sell_usd REAL,
    smart_money_trade_count INTEGER,
    kol_buy_usd REAL,
    kol_sell_usd REAL,
    kol_trade_count INTEGER
);

CREATE INDEX IF NOT EXISTS idx_realtime_pulse_snapshots_token_recorded
    ON realtime_pulse_snapshots(token_address, recorded_at DESC);

ALTER TABLE trading_bot_trades ADD COLUMN realtime_pulse_at_entry_json TEXT;

CREATE TABLE IF NOT EXISTS daily_trading_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_date TEXT NOT NULL UNIQUE,

    total_trades INTEGER,
    win_count INTEGER,
    loss_count INTEGER,
    win_rate REAL,
    net_profit_usd REAL,
    average_roi_pct REAL,
    average_mfe_pct REAL,
    average_mae_pct REAL,
    average_holding_seconds REAL,

    report_json TEXT NOT NULL,

    computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_daily_trading_reviews_review_date
    ON daily_trading_reviews(review_date DESC);
