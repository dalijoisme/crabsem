-- Wallet Detail panel (Product Improvement Sprint, Part 4) - Best
-- Trade/Worst Trade and Current Holdings both query
-- wallet_trade_positions filtered by a single wallet_address first.
-- Verified via EXPLAIN QUERY PLAN that, without a composite index,
-- SQLite chose idx_wallet_positions_status (filtering ALL ~11K
-- positions across every wallet by status first, then wallet_address,
-- then a temp B-tree sort) instead of narrowing to this one wallet's
-- ~2 real rows first - harmless at today's real row count, but the
-- wrong query plan to grow on.

CREATE INDEX IF NOT EXISTS idx_wallet_positions_wallet_status_roi
    ON wallet_trade_positions(wallet_address, status, roi_pct);
