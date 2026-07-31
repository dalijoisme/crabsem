-- Reset Trading Capital feature: additive, nullable baseline marker.
-- NULL (every existing row) reproduces today's behavior exactly -
-- availableCash is computed from ALL-time closed trades, unchanged.
-- Once a user resets, ledger_reset_at is stamped and
-- tradingBotService.js's getPortfolio() sums realizedPnl only from
-- trades closed AFTER this timestamp for the availableCash/equity
-- calculation - trade rows themselves are never deleted or modified,
-- and all-time reporting (win rate, total trades, profit factor,
-- total fees) still reads the complete, untouched history.

ALTER TABLE trading_bot_config ADD COLUMN ledger_reset_at TEXT;
