// repositories/tradingWalletRepository.js - the only place that
// reads/writes `trading_wallets` (the Trading Wallet - automated bot
// execution, deposit destination, position management; private key
// never leaves this layer, always encrypted at rest - see
// services/walletService.js).

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO trading_wallets (user_id, public_key, encrypted_private_key)
    VALUES (@userId, @publicKey, @encryptedPrivateKey)
`);

function insertWallet({ userId, publicKey, encryptedPrivateKey }){
    insertStmt.run({ userId, publicKey, encryptedPrivateKey });
}

function findByUserId(userId){
    return db.prepare("SELECT * FROM trading_wallets WHERE user_id = ?").get(userId);
}

// Production Stabilization V1 (Sections D/E/Q): every user_id with a
// real Trading Wallet - used by scheduler/walletBalanceSyncScheduler.js
// to keep each user's Trading Balance synced to their real on-chain
// balance on a timer, independent of whether their dashboard is open.
function findAllUserIds(){
    return db.prepare("SELECT user_id FROM trading_wallets").all().map(r => r.user_id);
}

// deposited_balance_usd column is DEPRECATED as of Production
// Stabilization V1 (Sections D/E/Q) - it was a self-reported balance
// that could silently drift from the real on-chain wallet (the root
// cause of a live Trading Allocation/Wallet Balance mismatch this sprint
// investigated and fixed). Trading Balance is now always derived from
// walletService.getRealWalletBalance(). The column is left in the
// schema, unread and unwritten, rather than dropped - this codebase's
// established additive-only migration convention.

module.exports = { insertWallet, findByUserId, findAllUserIds };
