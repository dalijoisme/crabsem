-- 038_password_reset_tokens.sql - Auth + Onboarding sprint. `used` is
-- a separate flag from expiry/deletion so a reset link can be safely
-- one-time-use even within its expiry window (a still-valid but
-- already-used token must not reset the password a second time) -
-- see services/userAuthService.js's resetPassword().

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
