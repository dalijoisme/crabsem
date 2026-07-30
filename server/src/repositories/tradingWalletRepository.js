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

// deposited_balance_usd - CRAB User Journey v1: the self-reported
// total Trading Wallet balance, separate from Trading Allocation
// (trading_bot_config.allocation_pct). depositFunds/withdrawFunds in
// services/walletService.js call this with the new absolute total,
// never a delta, so this repository never has to reason about +/-.
function setDepositedBalance(userId, depositedBalanceUsd){
    db.prepare("UPDATE trading_wallets SET deposited_balance_usd = ? WHERE user_id = ?").run(depositedBalanceUsd, userId);
}

module.exports = { insertWallet, findByUserId, setDepositedBalance };
