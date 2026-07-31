// services/walletService.test.js - Trust/UX sprint: getRealWalletBalance()
// is the real on-chain balance Production Stabilization V1 later made
// the ONLY source of Trading Balance (the old self-reported
// deposited_balance_usd model was removed - see the file's own header).
// These tests cover only the network-free path (no Trading Wallet yet) -
// exercising the real
// RPC/GMGN-quote path would require a real funded keypair and a live
// network call, out of scope for a fast, offline unit suite. Real
// end-to-end verification of the RPC/quote path is covered by manual
// read-only checks against the real Founder wallet (see
// scripts/founderDeploymentCheck.js), not here.
//
// Runs against the real database connection (integration-style, same
// convention as tradingBotService.test.js). Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const walletService = require("./walletService");
const userAuthService = require("./userAuthService");
const db = require("../database/connection");

function deleteTestUser(id){
    db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_wallets WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_wallets WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

const testEmail = `walletservice.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
assert.equal(registerResult.ok, true, "test fixture user must register successfully");
const userId = registerResult.userId;

test("getRealWalletBalance returns null (never a fabricated balance) when no Trading Wallet exists yet", async () => {
    const result = await walletService.getRealWalletBalance(userId);
    assert.equal(result, null);
});

test("getStatus returns tradingWallet: null (no real-balance fields fabricated) when no Trading Wallet exists yet", async () => {
    const status = await walletService.getStatus(userId);
    assert.equal(status.tradingWallet, null);
});

test.after(() => {
    deleteTestUser(userId);
});
