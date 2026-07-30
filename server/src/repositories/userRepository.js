// repositories/userRepository.js - the only place that reads/writes
// `users`. Sprint A Goal 2 (auth/multi-tenancy foundation) - a real,
// separate account system for the trading bot domain, independent of
// the existing admin system (adminAuthService.js/ADMIN_PASSWORD).

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO users (email, password_hash, full_name) VALUES (@email, @passwordHash, @fullName)
`);

function insertUser({ email, passwordHash, fullName }){
    const info = insertStmt.run({ email, passwordHash, fullName: fullName || null });
    return info.lastInsertRowid;
}

function findByEmail(email){
    return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
}

function findById(id){
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function markEmailVerified(userId){
    db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(userId);
}

function updatePasswordHash(userId, passwordHash){
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
}

module.exports = { insertUser, findByEmail, findById, markEmailVerified, updatePasswordHash };
