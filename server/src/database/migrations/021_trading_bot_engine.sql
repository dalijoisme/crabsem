-- 021_trading_bot_engine.sql - Trading Bot Architecture Audit (Phase 9):
-- adds the columns the real dry-run engine needs. Still SIMULATION-only -
-- no real GMGN trade/swap capability exists yet (see the audit report) -
-- but the virtual position lifecycle now needs real target/stop bands
-- (computed by the SAME productionEngineResolver.getActiveEngine()
-- buildRiskBands() the live prediction pipeline uses - not invented here)
-- and trading_bot_config needs the new dynamic re-entry/cooldown knobs
-- from the approved strategy design.

ALTER TABLE trading_bot_positions ADD COLUMN target_price REAL;
ALTER TABLE trading_bot_positions ADD COLUMN target_market_cap REAL;
ALTER TABLE trading_bot_positions ADD COLUMN stop_loss_price REAL;
ALTER TABLE trading_bot_positions ADD COLUMN stop_loss_market_cap REAL;
ALTER TABLE trading_bot_positions ADD COLUMN mfe_pct REAL DEFAULT 0;
ALTER TABLE trading_bot_positions ADD COLUMN mae_pct REAL DEFAULT 0;

-- Dynamic re-entry cooldown (Phase 5 of the approved strategy design):
-- same token MAY be re-entered after a close - what's forbidden is
-- overtrading, not re-entry itself. Cooldown length depends on WHY the
-- last position closed (a fresh TP win needs less caution than a stop
-- loss), and a minimum decay-fraction/confidence floor keeps entries
-- tied to a genuinely fresh, still-trustworthy decision - never a stale
-- one just because the tier label still reads BUY.
ALTER TABLE trading_bot_config ADD COLUMN min_confidence REAL NOT NULL DEFAULT 60;
ALTER TABLE trading_bot_config ADD COLUMN min_decay_fraction REAL NOT NULL DEFAULT 0.90;
ALTER TABLE trading_bot_config ADD COLUMN cooldown_win_minutes INTEGER NOT NULL DEFAULT 5;
ALTER TABLE trading_bot_config ADD COLUMN cooldown_loss_minutes INTEGER NOT NULL DEFAULT 30;
ALTER TABLE trading_bot_config ADD COLUMN cooldown_reversal_minutes INTEGER NOT NULL DEFAULT 15;
ALTER TABLE trading_bot_config ADD COLUMN cooldown_default_minutes INTEGER NOT NULL DEFAULT 10;

CREATE INDEX IF NOT EXISTS idx_trading_bot_positions_token ON trading_bot_positions(token_address);
CREATE INDEX IF NOT EXISTS idx_trading_bot_trades_token ON trading_bot_trades(token_address, closed_at);
