-- 040_trading_wallets.sql - Auth + Onboarding sprint. A real Solana
-- keypair generated server-side, scoped only for this user's bot -
-- see services/walletService.js's generateTradingWallet(). The
-- deposited balance intentionally has NO column here: it already
-- exists as trading_bot_config.initial_capital (the paper-trading
-- engine's real source of truth for bot capital) - reusing it avoids
-- two different numbers that both claim to mean "how much this bot
-- has to trade with."
--
-- encrypted_private_key is AES-256-GCM-encrypted with
-- TRADING_WALLET_ENCRYPTION_KEY (server .env) - explicitly
-- placeholder-grade custody for this sprint, not KMS/HSM-backed. Real
-- custody architecture is the named deliverable of the next sprint
-- (Trading Wallet & Execution Layer), not this one.

CREATE TABLE IF NOT EXISTS trading_wallets (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    public_key TEXT NOT NULL,
    encrypted_private_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
