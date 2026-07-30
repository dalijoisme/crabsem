-- 043_user_wallet_history.sql - CRAB User Journey v1 (locked). Owner
-- Wallet changes are never a silent replace - every connect and every
-- future replace writes a row here (previous_wallet_address is NULL
-- only for the very first connect, which has no "previous"). Not
-- required to be visible in any UI this sprint - exists for security/
-- investigation purposes only, per the explicit product decision.

CREATE TABLE IF NOT EXISTS user_wallet_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    previous_wallet_address TEXT,
    new_wallet_address TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_wallet_history_user_id ON user_wallet_history(user_id);
