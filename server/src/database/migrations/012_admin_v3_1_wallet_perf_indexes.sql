-- Admin Dashboard V3.1 - Wallet Performance redesign (Part 5/Part 12).
--
-- The redesigned Wallet Performance table lets every column be
-- clicked to sort by it (Prediction Count, TP, SL, Open, Average ROI,
-- Total ROI, Avg Holding Time - alongside the already-indexed Score/
-- Win Rate/Last Seen). Verified via EXPLAIN QUERY PLAN that, without
-- these, sorting by any of the columns below fell back to
-- "SCAN wallets" + "USE TEMP B-TREE FOR ORDER BY" (a full table scan
-- plus an in-memory sort) - harmless at today's real ~5.4K wallet
-- count, but exactly the failure mode Part 12 asks to be verified and
-- avoided as the table grows.

CREATE INDEX IF NOT EXISTS idx_wallets_total_trades ON wallets(total_trades);
CREATE INDEX IF NOT EXISTS idx_wallets_win_count ON wallets(win_count);
CREATE INDEX IF NOT EXISTS idx_wallets_loss_count ON wallets(loss_count);
CREATE INDEX IF NOT EXISTS idx_wallets_open_position_count ON wallets(open_position_count);
CREATE INDEX IF NOT EXISTS idx_wallets_avg_roi_pct ON wallets(avg_roi_pct);
CREATE INDEX IF NOT EXISTS idx_wallets_realized_profit_usd ON wallets(realized_profit_usd);
CREATE INDEX IF NOT EXISTS idx_wallets_avg_holding_seconds ON wallets(avg_holding_seconds);
