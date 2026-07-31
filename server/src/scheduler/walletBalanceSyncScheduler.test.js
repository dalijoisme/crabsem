// scheduler/walletBalanceSyncScheduler.test.js - Production Stabilization
// V1 (Sections D/E/Q). Proves runOnce() syncs Trading Balance
// (trading_bot_config.initial_capital) from each user's real wallet
// balance, skips a user with no real balance available (honest, never
// fabricated), and fails soft per-user.
//
// Stubs BOTH tradingWalletRepository.findAllUserIds AND
// walletService.getRealWalletBalance (same monkey-patch-a-required-
// module technique scheduler/tradingBotScheduler.test.js already uses)
// - findAllUserIds is stubbed to return ONLY this test's own disposable
// user id, so runOnce() never touches any other real account's row in
// the shared dev database. getRealWalletBalance is stubbed so this test
// makes zero real RPC/GMGN network calls - learning directly from this
// sprint's own hang incident on a similar real-network test. Run with
// `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { runOnce } = require("./walletBalanceSyncScheduler");
const tradingWalletRepository = require("../repositories/tradingWalletRepository");
const tradingBotRepository = require("../repositories/tradingBotRepository");
const walletService = require("../services/walletService");
const userAuthService = require("../services/userAuthService");
const db = require("../database/connection");

function deleteTestUser(id){
    db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_wallets WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

function stub(obj, method, fn){
    const original = obj[method];
    obj[method] = fn;
    return () => { obj[method] = original; };
}

test("runOnce syncs initial_capital from a real wallet balance for exactly the users it's given, never touching any other account", async () => {

    const testEmail = `walletbalsync.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    tradingWalletRepository.insertWallet({ userId, publicKey: `FakeSyncWallet${crypto.randomBytes(4).toString("hex")}`, encryptedPrivateKey: "unused" });

    const restores = [
        stub(tradingWalletRepository, "findAllUserIds", () => [userId]),
        stub(walletService, "getRealWalletBalance", async () => ({
            solLamports: 2000000000, solAmount: 2, solUsdPrice: 150, solUsd: 300, unavailableReason: null
        }))
    ];

    try{

        const result = await runOnce();
        assert.equal(result.total, 1);
        assert.equal(result.synced, 1);
        assert.equal(result.skipped, 0);
        assert.equal(result.failed, 0);

        const config = tradingBotRepository.getConfig(userId);
        // default allocation_pct is 100 - initial_capital must equal the
        // fake real balance's full $300, never left at the untouched
        // default (100) or any deposit-derived figure.
        assert.equal(config.initial_capital, 300);

    }
    finally{
        restores.forEach(restore => restore());
        deleteTestUser(userId);
    }

});

test("runOnce skips a user with no real balance available yet - never fabricates a Trading Balance", async () => {

    const testEmail = `walletbalsync.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    tradingWalletRepository.insertWallet({ userId, publicKey: `FakeSyncWalletNone${crypto.randomBytes(4).toString("hex")}`, encryptedPrivateKey: "unused" });

    const restores = [
        stub(tradingWalletRepository, "findAllUserIds", () => [userId]),
        stub(walletService, "getRealWalletBalance", async () => ({ solLamports: null, solAmount: null, solUsdPrice: null, solUsd: null, unavailableReason: "RPC balance read failed (simulated)" }))
    ];

    try{

        const beforeConfig = tradingBotRepository.getConfig(userId);
        const result = await runOnce();
        assert.equal(result.synced, 0);
        assert.equal(result.skipped, 1);

        const afterConfig = tradingBotRepository.getConfig(userId);
        assert.equal(afterConfig.initial_capital, beforeConfig.initial_capital, "initial_capital must be left exactly as it was, never zeroed or guessed");

    }
    finally{
        restores.forEach(restore => restore());
        deleteTestUser(userId);
    }

});
