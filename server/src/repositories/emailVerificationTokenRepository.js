// repositories/emailVerificationTokenRepository.js - the only place
// that reads/writes `email_verification_tokens`. Same convention as
// userSessionRepository.js - opaque, DB-persisted, expiring tokens.

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO email_verification_tokens (token, user_id, expires_at) VALUES (@token, @userId, @expiresAt)
`);

function insertToken({ token, userId, expiresAt }){
    insertStmt.run({ token, userId, expiresAt });
}

function findValidToken(token){
    return db.prepare(
        "SELECT * FROM email_verification_tokens WHERE token = ? AND datetime(expires_at) > datetime('now')"
    ).get(token);
}

function deleteToken(token){
    db.prepare("DELETE FROM email_verification_tokens WHERE token = ?").run(token);
}

function deleteAllForUser(userId){
    db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
}

module.exports = { insertToken, findValidToken, deleteToken, deleteAllForUser };
