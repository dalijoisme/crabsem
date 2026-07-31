-- Production Stabilization V1 Final Sprint (Section I - Scheduler
-- Safety): defense-in-depth, not a fix for a found bug - application
-- logic already prevents a duplicate real BUY (entryGateService.js's
-- ALREADY_OPEN_FOR_TOKEN check, plus tradingBotEngine.js's runCycle
-- processing candidates strictly sequentially within one user's
-- scheduler-guarded cycle - verified, no real race exists today).
-- This partial unique index makes that guarantee real at the database
-- level too, so no future code change to the BUY path could ever
-- silently reintroduce a duplicate OPEN position for the same
-- (user_id, token_address) - the database itself would reject the
-- second INSERT outright. Verified against the real local dataset
-- before adding this: zero existing duplicate-OPEN rows, so this
-- creates cleanly with no data cleanup required.

CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_bot_positions_one_open_per_token
ON trading_bot_positions(user_id, token_address)
WHERE status = 'OPEN';
