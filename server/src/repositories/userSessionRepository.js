// repositories/userSessionRepository.js - the only place that
// reads/writes `user_sessions`. DB-persisted opaque bearer tokens (see
// migration 034_users_auth.sql for why this is a real table and not an
// in-memory Map like adminAuthService.js's admin sessions).

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO user_sessions (token, user_id, expires_at) VALUES (@token, @userId, @expiresAt)
`);

function insertSession({ token, userId, expiresAt }){
    insertStmt.run({ token, userId, expiresAt });
}

// Only a session that hasn't expired counts as valid - an expired row
// is left in place (no eager delete-on-read here; a lazy sweep of
// long-expired rows is a reasonable future addition, not needed at
// Sprint A's scale).
function findValidSession(token){
    return db.prepare(
        "SELECT * FROM user_sessions WHERE token = ? AND datetime(expires_at) > datetime('now')"
    ).get(token);
}

function deleteSession(token){
    db.prepare("DELETE FROM user_sessions WHERE token = ?").run(token);
}

// Auth + Onboarding sprint - used by userAuthService.resetPassword() to
// force re-login everywhere a leaked/guessed old token might still work.
function deleteAllForUser(userId){
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
}

function deleteExpiredSessions(){
    const info = db.prepare("DELETE FROM user_sessions WHERE datetime(expires_at) <= datetime('now')").run();
    return info.changes;
}

module.exports = { insertSession, findValidSession, deleteSession, deleteExpiredSessions, deleteAllForUser };
