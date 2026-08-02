-- FINAL PRODUCTION SPRINT P0 - Exit Log acceptance criteria: "Actual
-- Exit Price" is a genuinely-measured on-chain fact (real SOL received
-- divided by the real token quantity that actually left the wallet -
-- transactionBalanceReader.js's own tokenDeltaUi), distinct from the
-- decision-time snapshot exit_price already stored. Additive, nullable -
-- null for SIMULATION/benchmark trades (no real on-chain swap exists)
-- and for any pre-this-sprint row. Never a second ROI - realized_roi_pct
-- (migration 066) remains the one official ROI; this column is an
-- observability fact only, never read by roiCalculator.js.

ALTER TABLE trading_bot_trades ADD COLUMN actual_exit_price REAL;
