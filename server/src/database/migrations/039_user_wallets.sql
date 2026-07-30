-- 039_user_wallets.sql - Auth + Onboarding sprint. The Main Wallet - a
-- Solana address the user proves ownership of via message signing
-- (services/walletService.js). Never used for trading, never asked
-- for a transaction signature - verified_at is set only after a real
-- signature check passes (NULL means "connected but not yet verified,"
-- a real distinct state, not implied by row-existence alone).

CREATE TABLE IF NOT EXISTS user_wallets (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    wallet_address TEXT NOT NULL,
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
