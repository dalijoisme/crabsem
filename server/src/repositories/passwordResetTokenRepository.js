// repositories/passwordResetTokenRepository.js - the only place that
// reads/writes `password_reset_tokens`. `used` is checked separately
// from expiry so a still-valid but already-consumed link can never
// reset a password a second time - see services/userAuthService.js's
// resetPassword().

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (@token, @userId, @expiresAt)
`);

function insertToken({ token, userId, expiresAt }){
    insertStmt.run({ token, userId, expiresAt });
}

function findValidToken(token){
    return db.prepare(
        "SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND datetime(expires_at) > datetime('now')"
    ).get(token);
}

function markUsed(token){
    db.prepare("UPDATE password_reset_tokens SET used = 1 WHERE token = ?").run(token);
}

function deleteAllForUser(userId){
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(userId);
}

module.exports = { insertToken, findValidToken, markUsed, deleteAllForUser };
