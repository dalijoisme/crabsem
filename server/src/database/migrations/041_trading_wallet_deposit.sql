-- 041_trading_wallet_deposit.sql - CRAB User Journey v1 (locked). The
-- self-reported total Trading Wallet balance - distinct from Trading
-- Allocation (042_trading_allocation.sql), which is a percentage OF
-- this balance, not an independent dollar figure. See
-- services/walletService.js's depositFunds()/withdrawFunds().

ALTER TABLE trading_wallets ADD COLUMN deposited_balance_usd REAL NOT NULL DEFAULT 0;
