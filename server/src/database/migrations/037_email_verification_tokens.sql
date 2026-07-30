-- 037_email_verification_tokens.sql - Auth + Onboarding sprint. Same
-- shape/convention as user_sessions (034_users_auth.sql) - an opaque,
-- DB-persisted, expiring token, not a JWT. One row per outstanding
-- verification link; consumed (deleted) on successful verification -
-- see services/userAuthService.js's verifyEmail().

CREATE TABLE IF NOT EXISTS email_verification_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);
