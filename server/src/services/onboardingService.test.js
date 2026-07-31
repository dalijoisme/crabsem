// services/onboardingService.test.js - Production Stabilization V1
// (Sections D/E/Q): getOnboardingStatus became async, and its
// depositCompleted step now checks the REAL on-chain wallet balance
// (walletService.getRealWalletBalance) instead of the removed
// self-reported deposited_balance_usd. Stubs
// walletService.getRealWalletBalance (same monkey-patch-a-required-
// module technique scheduler/tradingBotScheduler.test.js already uses)
// to avoid a real RPC/GMGN network call - SOLANA_RPC_URL is genuinely
// configured in this dev environment. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const onboardingService = require("./onboardingService");
const walletService = require("./walletService");
const tradingWalletRepository = require("../repositories/tradingWalletRepository");
const userAuthService = require("./userAuthService");
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

test("depositCompleted is false with no Trading Wallet, and never calls getRealWalletBalance for one that doesn't exist", async () => {

    const testEmail = `onboarding.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    const restore = stub(walletService, "getRealWalletBalance", async () => {
        throw new Error("must never be called - no Trading Wallet exists for this user");
    });

    try{

        const status = await onboardingService.getOnboardingStatus(userId);
        const depositStep = status.steps.find(s => s.key === "depositCompleted");
        assert.ok(depositStep);
        assert.equal(depositStep.done, false);

    }
    finally{
        restore();
        deleteTestUser(userId);
    }

});

test("depositCompleted is true once the real wallet balance is a real, positive USD figure", async () => {

    const testEmail = `onboarding.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    tradingWalletRepository.insertWallet({ userId, publicKey: `FakeOnboardWallet${crypto.randomBytes(4).toString("hex")}`, encryptedPrivateKey: "unused" });

    const restore = stub(walletService, "getRealWalletBalance", async () => ({
        solLamports: 500000000, solAmount: 0.5, solUsdPrice: 200, solUsd: 100, unavailableReason: null
    }));

    try{

        const status = await onboardingService.getOnboardingStatus(userId);
        const depositStep = status.steps.find(s => s.key === "depositCompleted");
        assert.equal(depositStep.done, true);

    }
    finally{
        restore();
        deleteTestUser(userId);
    }

});

test("depositCompleted stays false when the real wallet exists but its balance is genuinely unavailable - never fabricated", async () => {

    const testEmail = `onboarding.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    tradingWalletRepository.insertWallet({ userId, publicKey: `FakeOnboardWalletNone${crypto.randomBytes(4).toString("hex")}`, encryptedPrivateKey: "unused" });

    const restore = stub(walletService, "getRealWalletBalance", async () => ({
        solLamports: null, solAmount: null, solUsdPrice: null, solUsd: null, unavailableReason: "RPC balance read failed (simulated)"
    }));

    try{

        const status = await onboardingService.getOnboardingStatus(userId);
        const depositStep = status.steps.find(s => s.key === "depositCompleted");
        assert.equal(depositStep.done, false);

    }
    finally{
        restore();
        deleteTestUser(userId);
    }

});
