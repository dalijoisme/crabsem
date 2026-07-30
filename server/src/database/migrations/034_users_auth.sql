-- 034_users_auth.sql - Sprint A, Goal 2 (auth/multi-tenancy foundation).
-- A real, separate user account system for the trading bot domain -
-- entirely independent of the existing admin system
-- (middleware/adminAuth.js / services/adminAuthService.js / ADMIN_PASSWORD),
-- which is untouched. Modeled on that file's own token-header
-- convention, but DB-persisted (not an in-memory Map) - a bot meant to
-- run and be checked on for weeks must survive a server restart without
-- silently logging its owner out.
--
-- password_hash stores Node's built-in crypto.scrypt output as
-- "salt:derivedKeyHex" (see services/userAuthService.js) - no new
-- dependency, matches this codebase's existing zero-auth-library stack.

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Opaque bearer tokens, not JWT - real revocation (DELETE the row) needs
-- no separate blocklist table. 30-day expiry (see userAuthService.js) -
-- longer than the admin session's 24h, because Goal 1 needs the bot's
-- owner to check on a real, multi-week profit track record without
-- being forced to re-login constantly.
CREATE TABLE IF NOT EXISTS user_sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
