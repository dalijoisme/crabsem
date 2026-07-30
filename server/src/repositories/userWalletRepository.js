// repositories/userWalletRepository.js - the only place that
// reads/writes `user_wallets` (the Owner Wallet - account ownership,
// security verification, withdraw destination; never used for
// trading) and `user_wallet_history` (CRAB User Journey v1 - every
// connect/replace is recorded, never a silent overwrite; not required
// to be visible in any UI, exists for security/investigation only).

const db = require("../database/connection");

function findByUserId(userId){
    return db.prepare("SELECT * FROM user_wallets WHERE user_id = ?").get(userId);
}

// Upsert - a user has exactly one CURRENT Owner Wallet row; history of
// previous ones lives in user_wallet_history, written by insertHistory
// below, always called alongside this by services/walletService.js so
// the two can never drift apart.
function upsertWallet(userId, walletAddress){
    db.prepare(`
        INSERT INTO user_wallets (user_id, wallet_address, verified_at)
        VALUES (@userId, @walletAddress, NULL)
        ON CONFLICT(user_id) DO UPDATE SET wallet_address = @walletAddress, verified_at = NULL
    `).run({ userId, walletAddress });
}

function markVerified(userId){
    db.prepare("UPDATE user_wallets SET verified_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(userId);
}

function insertHistory({ userId, previousAddress, newAddress }){
    db.prepare(`
        INSERT INTO user_wallet_history (user_id, previous_wallet_address, new_wallet_address)
        VALUES (@userId, @previousAddress, @newAddress)
    `).run({ userId, previousAddress: previousAddress || null, newAddress });
}

function findHistory(userId){
    return db.prepare("SELECT * FROM user_wallet_history WHERE user_id = ? ORDER BY changed_at DESC").all(userId);
}

module.exports = { findByUserId, upsertWallet, markVerified, insertHistory, findHistory };
