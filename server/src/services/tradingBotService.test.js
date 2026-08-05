// services/tradingBotService.test.js - Final Spec section 02/18: proves
// Strategy Profile's core API contract - profile-owned fields can never
// be set directly, switching profile always applies the real bundle,
// and an invalid profile name is rejected. Runs against the real
// database connection (integration-style, matching this codebase's own
// convention of repositories being thin wrappers with no separate test
// double).
//
// Sprint A, Goal 2 (auth/multi-tenancy foundation): every
// tradingBotService call now takes a leading userId, and
// trading_bot_config.user_id is a real FK REFERENCES users(id) enforced
// under PRAGMA foreign_keys=ON (database/connection.js) - this suite
// creates one real, disposable test user via userAuthService.register()
// (which also seeds a default bot row via ensureBotForUser), runs
// against that user's own bot, and deletes the user/bot rows it created
// in test.after() so the dev database is left exactly as this suite
// found it. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const tradingBotService = require("./tradingBotService");
const userAuthService = require("./userAuthService");
const walletService = require("./walletService");
const tradingWalletRepository = require("../repositories/tradingWalletRepository");
const tradingBotRepository = require("../repositories/tradingBotRepository");
const tradingBotMissedOpportunityRepository = require("../repositories/tradingBotMissedOpportunityRepository");
const tradingBotCandidateSightingsRepository = require("../repositories/tradingBotCandidateSightingsRepository");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");
const tradingBotFreshUniverseSnapshotRepository = require("../repositories/tradingBotFreshUniverseSnapshotRepository");
const db = require("../database/connection");

// Inserts a real, disposable OPEN position row directly (bypassing the
// full scan pipeline) so forceSellAll()/sellPosition() have something
// real to close. No token row is inserted - gmgnTokenRepository.getTokenByAddress
// correctly returns undefined for it, and tradingBotService's
// currentPriceFor() falls back to the position's own entryPrice, exactly
// the same fallback tradeManager.closeIfDue() already relies on.
function insertTestOpenPosition(userId, tokenAddress){
    return tradingBotRepository.insertPosition(userId, {
        tokenAddress, tokenSymbol: "TEST",
        entryPrice: 1.0, sizeUsd: 10, confidence: 60,
        exitStrategy: "dynamicExit", engineVersion: "production_v2",
        targetPrice: 1.2, targetMarketCap: null, stopLossPrice: 0.9, stopLossMarketCap: null
    });
}

// Every table a test user's bot can touch, in FK-safe order (children
// before the users row itself - trading_bot_log/positions/trades/
// equity_snapshot/user_sessions/email_verification_tokens/
// password_reset_tokens/user_wallets/trading_wallets all REFERENCES
// users(id), enforced under PRAGMA foreign_keys=ON). register() now
// always issues an email_verification_tokens row (Auth + Onboarding
// sprint), so that table joined this cleanup list too.
function deleteTestUser(id){
    db.prepare("DELETE FROM trading_bot_missed_opportunity WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_candidate_sightings WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_trades WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_wallets WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_wallets WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

const testEmail = `tradingbotservice.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
assert.equal(registerResult.ok, true, "test fixture user must register successfully");
const userId = registerResult.userId;

test("direct profile-owned field writes are silently ignored", () => {
    const before = tradingBotService.getConfig(userId);
    const result = tradingBotService.updateConfig(userId, { min_confidence: 999 });
    assert.equal(result.ok, true);
    assert.equal(result.config.min_confidence, before.min_confidence);
});

test("switching strategy_profile applies the full real bundle", () => {
    const result = tradingBotService.updateConfig(userId, { strategy_profile: "AGGRESSIVE" });
    assert.equal(result.ok, true);
    assert.equal(result.config.strategy_profile, "AGGRESSIVE");
    assert.equal(result.config.min_confidence, 45);
    assert.equal(result.config.opportunity_priority_enabled, 1);
    assert.equal(result.config.emi_enabled, 1);
});

// Trading Configuration sprint: position_size_pct/max_position_size/
// max_open_positions are DELIBERATELY no longer profile-owned - the
// position-sizing audit found no real reason they should require a
// profile switch to change. A never-customized account's profile switch
// must still SEED them as real defaults (regression guard - identical to
// today's behavior for any account that hasn't visited the new page).
test("position_size_pct/max_position_size/max_open_positions are now directly settable, and a never-customized profile switch still seeds real defaults", () => {

    const testEmail = `tradingbotservice.test.tc.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const tcUserId = registerResult.userId;

    try{
        // Direct write, no profile switch involved - must actually take,
        // and (by design) counts as a real customization regardless of
        // which caller/endpoint triggered it.
        const direct = tradingBotService.updateConfig(tcUserId, { position_size_pct: 33, max_open_positions: 4 });
        assert.equal(direct.ok, true);
        assert.equal(direct.config.position_size_pct, 33);
        assert.equal(direct.config.max_open_positions, 4);
        assert.ok(direct.config.trading_config_customized_at, "any real write to these fields, via any path, counts as a customization");

    }
    finally{
        deleteTestUser(tcUserId);
    }

});

// A genuinely never-customized account (fresh, no Trading Configuration
// save at all) must still have its profile switch seed real sizing
// defaults - identical to pre-this-sprint behavior for every existing
// account that never visits the new page.
test("a genuinely never-customized account's profile switch still seeds real strategy-profile sizing defaults", () => {

    const testEmail = `tradingbotservice.test.tc.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const tcUserId = registerResult.userId;

    try{

        const switched = tradingBotService.updateConfig(tcUserId, { strategy_profile: "AGGRESSIVE" });
        assert.equal(switched.ok, true);
        assert.equal(switched.config.position_size_pct, 15);
        assert.equal(switched.config.max_open_positions, 10);

    }
    finally{
        deleteTestUser(tcUserId);
    }

});

// Once a Founder has explicitly customized via updateTradingConfiguration
// (trading_config_customized_at set), a LATER profile switch (chosen for
// the ranking/philosophy change) must preserve their own numbers, never
// silently reset them back to that profile's defaults.
test("updateTradingConfiguration stamps trading_config_customized_at, and a later profile switch preserves the customized sizing", () => {

    const testEmail = `tradingbotservice.test.tc.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const tcUserId = registerResult.userId;

    try{

        const updated = tradingBotService.updateTradingConfiguration(tcUserId, { positionSizePct: 42, maxOpenPositions: 2 });
        assert.equal(updated.ok, true);
        assert.equal(updated.config.position_size_pct, 42);
        assert.equal(updated.config.max_open_positions, 2);
        assert.ok(updated.config.trading_config_customized_at, "a real Trading Configuration save must stamp the customized-at timestamp");

        // AGGRESSIVE's own bundle sets position_size_pct:15/max_open_positions:10 -
        // must NOT overwrite this Founder's own 42/2 now that they're customized.
        const switched = tradingBotService.updateConfig(tcUserId, { strategy_profile: "AGGRESSIVE" });
        assert.equal(switched.ok, true);
        assert.equal(switched.config.strategy_profile, "AGGRESSIVE");
        assert.equal(switched.config.min_confidence, 45, "the real AGGRESSIVE philosophy bundle must still apply to every profile-owned field");
        assert.equal(switched.config.position_size_pct, 42, "customized position_size_pct must survive the profile switch");
        assert.equal(switched.config.max_open_positions, 2, "customized max_open_positions must survive the profile switch");

    }
    finally{
        deleteTestUser(tcUserId);
    }

});

test("updateTradingConfiguration rejects out-of-range inputs with real, specific errors and writes nothing", () => {

    const testEmail = `tradingbotservice.test.tc.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const tcUserId = registerResult.userId;

    try{

        const before = tradingBotService.getConfig(tcUserId);

        const badPct = tradingBotService.updateTradingConfiguration(tcUserId, { positionSizePct: 150 });
        assert.equal(badPct.ok, false);
        assert.ok(badPct.errors[0].includes("Position Size %"));

        const badSlots = tradingBotService.updateTradingConfiguration(tcUserId, { maxOpenPositions: 0 });
        assert.equal(badSlots.ok, false);

        const badMode = tradingBotService.updateTradingConfiguration(tcUserId, { positionSizingMode: "SOMETHING_ELSE" });
        assert.equal(badMode.ok, false);

        const after = tradingBotService.getConfig(tcUserId);
        assert.equal(after.position_size_pct, before.position_size_pct, "a rejected update must write nothing");
        assert.equal(after.trading_config_customized_at, null);

    }
    finally{
        deleteTestUser(tcUserId);
    }

});

// Exit Evaluation Interval sprint: independent of scan_interval_seconds
// (not editable here) - configurable 1-30s, defaults to 5.
test("updateTradingConfiguration validates Exit Evaluation Interval to 1-30 seconds and defaults to 5", () => {

    const testEmail = `tradingbotservice.test.tc.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const tcUserId = registerResult.userId;

    try{

        const fresh = tradingBotService.getConfig(tcUserId);
        assert.equal(fresh.exit_evaluation_interval_seconds, 5, "a never-customized account must default to 5s");

        const tooLow = tradingBotService.updateTradingConfiguration(tcUserId, { exitEvaluationIntervalSeconds: 0 });
        assert.equal(tooLow.ok, false);
        assert.ok(tooLow.errors[0].includes("Exit Evaluation Interval"));

        const tooHigh = tradingBotService.updateTradingConfiguration(tcUserId, { exitEvaluationIntervalSeconds: 31 });
        assert.equal(tooHigh.ok, false);

        const notInteger = tradingBotService.updateTradingConfiguration(tcUserId, { exitEvaluationIntervalSeconds: 2.5 });
        assert.equal(notInteger.ok, false);

        const valid = tradingBotService.updateTradingConfiguration(tcUserId, { exitEvaluationIntervalSeconds: 1 });
        assert.equal(valid.ok, true);
        assert.equal(valid.config.exit_evaluation_interval_seconds, 1);

    }
    finally{
        deleteTestUser(tcUserId);
    }

});

test("getTradingConfiguration surfaces exitEvaluationIntervalSeconds under sizing", async () => {

    const testEmail = `tradingbotservice.test.tc.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const tcUserId = registerResult.userId;

    try{

        tradingBotService.updateTradingConfiguration(tcUserId, { exitEvaluationIntervalSeconds: 3 });
        const tc = await tradingBotService.getTradingConfiguration(tcUserId);
        assert.equal(tc.sizing.exitEvaluationIntervalSeconds, 3);

    }
    finally{
        deleteTestUser(tcUserId);
    }

});

// Position sizing mode switch (PERCENT -> FIXED_USD) - real validation,
// real persistence, and clearing back to null (never using fixed mode)
// is itself a real, explicit state, not an ignored no-op.
test("updateTradingConfiguration supports switching to FIXED_USD sizing and clearing it back", () => {

    const testEmail = `tradingbotservice.test.tc.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const tcUserId = registerResult.userId;

    try{

        const toFixed = tradingBotService.updateTradingConfiguration(tcUserId, { positionSizingMode: "FIXED_USD", fixedPositionSizeUsd: 25 });
        assert.equal(toFixed.ok, true);
        assert.equal(toFixed.config.position_sizing_mode, "FIXED_USD");
        assert.equal(toFixed.config.fixed_position_size_usd, 25);

        const cleared = tradingBotService.updateTradingConfiguration(tcUserId, { positionSizingMode: "PERCENT", fixedPositionSizeUsd: null });
        assert.equal(cleared.ok, true);
        assert.equal(cleared.config.position_sizing_mode, "PERCENT");
        assert.equal(cleared.config.fixed_position_size_usd, null, "explicitly clearing back to null must actually persist null, not be ignored as \"no value provided\"");

    }
    finally{
        deleteTestUser(tcUserId);
    }

});

// getTradingConfiguration: honest fallback/unavailable states for an
// account with no real Trading Wallet - never a fabricated balance.
test("getTradingConfiguration reports honest unavailable wallet state and real sizing config for an account with no Trading Wallet", async () => {

    const testEmail = `tradingbotservice.test.tc.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const tcUserId = registerResult.userId;

    try{

        const tc = await tradingBotService.getTradingConfiguration(tcUserId);
        assert.equal(tc.walletBalanceUsd, null);
        assert.equal(tc.walletBalanceSource, "UNAVAILABLE");
        assert.equal(tc.walletBalanceUnavailableReason, "No Trading Wallet is configured for this account yet", "production hotfix: the real, specific reason must reach the API caller, not just the fact that it's unavailable");
        assert.equal(tc.reservedUsd, null, "reserved must be honestly unavailable, never computed from a missing wallet balance");
        assert.equal(tc.tradingAllocationUsd, 100); // real default initial_capital
        assert.equal(tc.sizing.mode, "PERCENT");
        assert.equal(tc.customized, false);

        await tradingBotService.updateTradingConfiguration(tcUserId, { maxOpenPositions: 6 });
        const tcAfter = await tradingBotService.getTradingConfiguration(tcUserId);
        assert.equal(tcAfter.sizing.maxOpenPositions, 6);
        assert.equal(tcAfter.customized, true);

    }
    finally{
        deleteTestUser(tcUserId);
    }

});

// Production hotfix: a Trading Wallet DOES exist, but the real balance
// read itself failed (RPC timeout, RPC misconfigured, etc.) -
// walletService.js already computes a real, specific unavailableReason
// for this exact case; this proves it now survives all the way to the
// API response instead of being silently discarded, so a stuck "Wallet
// Balance: Unavailable" is diagnosable instead of a dead end.
test("getTradingConfiguration surfaces the real reason when a Trading Wallet exists but the RPC balance read failed", async () => {

    const testEmail = `tradingbotservice.test.tcreason.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const tcUserId = registerResult.userId;

    tradingWalletRepository.insertWallet({ userId: tcUserId, publicKey: `FakeReasonWallet${crypto.randomBytes(4).toString("hex")}`, encryptedPrivateKey: "unused" });

    const restore = stub(walletService, "getRealWalletBalance", async () => ({
        publicKey: "FakeReasonWallet", solLamports: null, solAmount: null, solUsdPrice: null, solUsd: null,
        unavailableReason: "RPC balance read failed: connect ETIMEDOUT (simulated)"
    }));

    try{

        const tc = await tradingBotService.getTradingConfiguration(tcUserId);
        assert.equal(tc.walletBalanceUsd, null);
        assert.equal(tc.walletBalanceSource, "UNAVAILABLE");
        assert.equal(tc.walletBalanceUnavailableReason, "RPC balance read failed: connect ETIMEDOUT (simulated)");

    }
    finally{
        restore();
        deleteTestUser(tcUserId);
    }

});

// Monkey-patch-a-required-module technique (same one
// scheduler/tradingBotScheduler.test.js already uses) - avoids a real
// RPC/GMGN network call (SOLANA_RPC_URL is genuinely configured in this
// dev environment), learning directly from this sprint's own hang
// incident on a similar real-network test.
function stub(obj, method, fn){
    const original = obj[method];
    obj[method] = fn;
    return () => { obj[method] = original; };
}

// Production Stabilization V1 (Sections D/E/Q): the self-reported
// deposited_balance_usd/MANUAL_DEPOSIT fallback is gone -
// getTradingConfiguration must sync Trading Balance (initial_capital)
// from the REAL wallet balance and persist it (write-through), not just
// return it in-memory.
test("getTradingConfiguration syncs Trading Balance from a real wallet balance (write-through) and never reports MANUAL_DEPOSIT", async () => {

    const testEmail = `tradingbotservice.test.realbal.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const rbUserId = registerResult.userId;

    const restore = stub(walletService, "getRealWalletBalance", async () => ({
        solLamports: 1666666667, solAmount: 1.666666667, solUsdPrice: 150, solUsd: 250, unavailableReason: null
    }));

    try{

        const tc = await tradingBotService.getTradingConfiguration(rbUserId);

        assert.equal(tc.walletBalanceSource, "REAL");
        assert.equal(tc.walletBalanceUsd, 250);
        // default allocation_pct is 100% - must equal the real $250, a
        // DIFFERENT number than the untouched default initial_capital
        // (100), proving this actually synced rather than coincidentally
        // matching a leftover default.
        assert.equal(tc.tradingAllocationUsd, 250);

        const configRow = tradingBotRepository.getConfig(rbUserId);
        assert.equal(configRow.initial_capital, 250, "initial_capital must be PERSISTED (write-through), not just returned in-memory");

    }
    finally{
        restore();
        deleteTestUser(rbUserId);
    }

});

// Production Stabilization V1 (Sections D/E/Q): setAllocation's basis is
// now the real wallet balance, never tradingWallet.deposited_balance_usd
// (removed).
test("setAllocation computes Trading Balance from the real wallet balance, never a deposit figure", async () => {

    const testEmail = `tradingbotservice.test.alloc.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const allocUserId = registerResult.userId;

    tradingWalletRepository.insertWallet({ userId: allocUserId, publicKey: `FakeAllocWallet${crypto.randomBytes(4).toString("hex")}`, encryptedPrivateKey: "unused" });

    const restore = stub(walletService, "getRealWalletBalance", async () => ({
        solLamports: 1000000000, solAmount: 1, solUsdPrice: 300, solUsd: 300, unavailableReason: null
    }));

    try{

        const result = await tradingBotService.setAllocation(allocUserId, 40);
        assert.equal(result.ok, true);
        assert.equal(result.config.allocation_pct, 40);
        assert.equal(result.config.initial_capital, 120, "40% of a real $300 wallet balance, never a deposit-derived figure");

    }
    finally{
        restore();
        deleteTestUser(allocUserId);
    }

});

// Never fabricate a Trading Balance when no real balance exists yet -
// the Founder can still set an allocation % ahead of funding their
// wallet, it just starts at $0 until a real balance is available.
test("setAllocation writes initial_capital: 0 (never fabricated) when no real balance is available yet", async () => {

    const testEmail = `tradingbotservice.test.alloc2.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const allocUserId = registerResult.userId;

    tradingWalletRepository.insertWallet({ userId: allocUserId, publicKey: `FakeAllocWalletNone${crypto.randomBytes(4).toString("hex")}`, encryptedPrivateKey: "unused" });

    const restore = stub(walletService, "getRealWalletBalance", async () => ({
        solLamports: null, solAmount: null, solUsdPrice: null, solUsd: null, unavailableReason: "RPC balance read failed (simulated)"
    }));

    try{

        const result = await tradingBotService.setAllocation(allocUserId, 50);
        assert.equal(result.ok, true);
        assert.equal(result.config.allocation_pct, 50);
        assert.equal(result.config.initial_capital, 0);

    }
    finally{
        restore();
        deleteTestUser(allocUserId);
    }

});

// Reset Trading Capital: Founder-only. A non-Founder wallet must be
// rejected even when a real balance IS available - the gate checks the
// wallet's public key, never whether a balance happens to exist.
test("resetTradingCapital rejects a wallet that is not the configured Founder Trading Wallet", async () => {

    const testEmail = `tradingbotservice.test.resetreject.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const rejectUserId = registerResult.userId;

    tradingWalletRepository.insertWallet({ userId: rejectUserId, publicKey: `NotFounderWallet${crypto.randomBytes(4).toString("hex")}`, encryptedPrivateKey: "unused" });

    const restore = stub(walletService, "getRealWalletBalance", async () => ({
        solLamports: 1000000000, solAmount: 1, solUsdPrice: 200, solUsd: 200, unavailableReason: null
    }));

    try{
        const result = await tradingBotService.resetTradingCapital(rejectUserId);
        assert.equal(result.ok, false);
        assert.match(result.error, /Founder Trading Wallet/);

        const config = tradingBotRepository.getConfig(rejectUserId);
        assert.equal(config.ledger_reset_at, null, "a rejected reset must never touch ledger_reset_at");

    }
    finally{
        restore();
        deleteTestUser(rejectUserId);
    }

});

// Reset Trading Capital: the real, end-to-end feature. Builds up a
// realistic CASH_EXHAUSTED_BEFORE_TURN shape (a real closed trade with
// heavy realized losses depresses availableCash below min_order_size
// even though the real wallet still holds tradeable SOL), then proves
// the reset brings availableCash back to the fresh wallet-derived
// baseline WITHOUT deleting the trade row or resetting its all-time PnL
// reporting.
test("resetTradingCapital sets availableCash to the real wallet balance without deleting trade/PnL history", async () => {

    const testEmail = `tradingbotservice.test.resetok.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const resetUserId = registerResult.userId;

    const envConfig = require("../config/env");
    const founderPublicKey = envConfig.FOUNDER_WALLET_PUBLIC_KEY;
    assert.ok(founderPublicKey, "FOUNDER_WALLET_PUBLIC_KEY must be configured for this test to mean anything");

    tradingWalletRepository.insertWallet({ userId: resetUserId, publicKey: founderPublicKey, encryptedPrivateKey: "unused" });
    tradingBotRepository.setAllocationAndCapital(resetUserId, 100, 13.122466);

    // A real closed trade with a heavy realized loss - exactly the
    // production shape (realizedPnL = -12.309702) that drives
    // availableCash below min_order_size while openValue stays 0.
    const positionId = insertTestOpenPosition(resetUserId, "ResetCapitalTestToken111");
    const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
    tradingBotRepository.closePosition(resetUserId, position, {
        exitPrice: 0.05, roiPct: -95, feeUsd: 0.1, slippagePct: 0, durationSeconds: 300, reason: "STOP_LOSS"
    });

    const beforePortfolio = tradingBotService.getPortfolio(resetUserId);
    assert.ok(beforePortfolio.availableCash < tradingBotRepository.getConfig(resetUserId).min_order_size,
        "fixture must reproduce CASH_EXHAUSTED_BEFORE_TURN before the reset - otherwise this test proves nothing");

    const restore = stub(walletService, "getRealWalletBalance", async () => ({
        solLamports: 87483106667, solAmount: 87.483106667, solUsdPrice: 0.15, solUsd: 13.122466, unavailableReason: null
    }));

    try{

        const result = await tradingBotService.resetTradingCapital(resetUserId);
        assert.equal(result.ok, true);
        assert.equal(result.walletBalanceUsd, 13.122466);
        assert.ok(Math.abs(result.freshInitialCapital - 13.122466) < 1e-9);
        assert.ok(result.config.ledger_reset_at, "ledger_reset_at must be stamped");

        // The whole point: availableCash now equals the fresh wallet
        // balance (openValue is 0 in this fixture), not depressed by the
        // pre-reset realized loss.
        const afterPortfolio = tradingBotService.getPortfolio(resetUserId);
        assert.ok(Math.abs(afterPortfolio.availableCash - 13.122466) < 1e-9,
            `availableCash must equal the real wallet balance after reset, got ${afterPortfolio.availableCash}`);

        // PnL history must remain intact: all-time reporting fields still
        // reflect the real historical trade, never reset to zero.
        assert.equal(afterPortfolio.totalTrades, 1);
        assert.equal(afterPortfolio.winRate, 0);
        assert.ok(afterPortfolio.realizedProfit < 0, "the real historical loss must still be reported, never erased");

        // Trade history must remain intact: the row itself still exists.
        const stillThere = db.prepare("SELECT * FROM trading_bot_trades WHERE user_id = ? AND token_address = ?").get(resetUserId, "ResetCapitalTestToken111");
        assert.ok(stillThere, "the closed trade row must never be deleted by a Reset Trading Capital action");
        assert.equal(stillThere.reason, "STOP_LOSS");

        // No hidden resets - a real, visible log row documents the change.
        const log = tradingBotRepository.findRecentLog(resetUserId, 1)[0];
        assert.equal(log.log_type, "SYSTEM");
        assert.match(log.message, /Trading Capital reset/);

    }
    finally{
        restore();
        deleteTestUser(resetUserId);
    }

});

test("a smuggled bundle-field override alongside a profile switch never wins over the real bundle", () => {
    const result = tradingBotService.updateConfig(userId, { strategy_profile: "STABLE", min_confidence: 999, opportunity_priority_enabled: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.config.strategy_profile, "STABLE");
    assert.equal(result.config.min_confidence, 65);
    assert.equal(result.config.opportunity_priority_enabled, 0);
});

test("an invalid strategy_profile name is rejected, not silently coerced", () => {
    const result = tradingBotService.updateConfig(userId, { strategy_profile: "ULTRA_MODE" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("STABLE, BALANCED, AGGRESSIVE")));
});

test("global fields (not profile-owned) remain directly settable regardless of profile", () => {
    const before = tradingBotService.getConfig(userId);
    const result = tradingBotService.updateConfig(userId, { scan_interval_seconds: 45 });
    assert.equal(result.config.scan_interval_seconds, 45);
    assert.equal(result.config.strategy_profile, before.strategy_profile);
    tradingBotService.updateConfig(userId, { scan_interval_seconds: before.scan_interval_seconds }); // restore
});

test("bot state/config are scoped per user - a second user never sees the first's settings", async () => {
    const otherEmail = `tradingbotservice.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const otherResult = userAuthService.register(null, otherEmail, "test-password-12345");
    assert.equal(otherResult.ok, true);
    const otherUserId = otherResult.userId;

    try{
        tradingBotService.updateConfig(userId, { strategy_profile: "AGGRESSIVE" });
        const otherConfig = tradingBotService.getConfig(otherUserId);
        assert.equal(otherConfig.strategy_profile, "STABLE"); // untouched default, not AGGRESSIVE

        await tradingBotService.startBot(userId);
        const otherState = tradingBotService.getStatusBar(otherUserId);
        assert.equal(otherState.tradingStatus, "STOPPED"); // untouched, unaffected by userId's start
        tradingBotService.stopBot(userId);
    }
    finally{
        deleteTestUser(otherUserId);
    }
});

// Trust/UX sprint: forceSellAll used to be a no-op stub (logged "would
// be closed", never actually closed anything). Proves it now really
// closes real position rows through tradeManager.finalizeClose().
test("forceSellAll actually closes open positions - was a no-op stub, now real", async () => {

    const positionId = insertTestOpenPosition(userId, "TestTokenForceSellAll111");

    const result = await tradingBotService.forceSellAll(userId);
    assert.equal(result.ok, true);
    assert.equal(result.positionsAffected, 1);
    assert.equal(result.positionsAttempted, 1);

    const position = db.prepare("SELECT status FROM trading_bot_positions WHERE id = ?").get(positionId);
    assert.equal(position.status, "CLOSED");

    const trade = db.prepare("SELECT reason FROM trading_bot_trades WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId);
    assert.equal(trade.reason, "SELL_MANUAL");

});

test("forceSellAll with no open positions is an honest no-op, never a fabricated success count", async () => {
    const result = await tradingBotService.forceSellAll(userId);
    assert.equal(result.ok, true);
    assert.equal(result.positionsAffected, 0);
    assert.equal(result.positionsAttempted, 0);
});

test("sellPosition closes exactly the one targeted position through the same real close path", async () => {

    const targetId = insertTestOpenPosition(userId, "TestTokenSellOne111");
    const otherId = insertTestOpenPosition(userId, "TestTokenSellOneOther111");

    const result = await tradingBotService.sellPosition(userId, targetId);
    assert.equal(result.ok, true);
    assert.equal(result.closed, true);

    const target = db.prepare("SELECT status FROM trading_bot_positions WHERE id = ?").get(targetId);
    const other = db.prepare("SELECT status FROM trading_bot_positions WHERE id = ?").get(otherId);
    assert.equal(target.status, "CLOSED");
    assert.equal(other.status, "OPEN"); // untouched - proves this is scoped to one position, not all

    // Clean up the still-open sibling so it doesn't linger past this test.
    await tradingBotService.sellPosition(userId, otherId);

});

test("sellPosition on a nonexistent/already-closed/other-user's position returns a real 404, never a fake success", async () => {
    const result = await tradingBotService.sellPosition(userId, 999999999);
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
});

// Trust/UX sprint: getPortfolioReconciliation() adds the real on-chain
// balance alongside the unchanged ledger - proves the "no Trading Wallet
// yet" path returns an honest null (never a fabricated balance/delta),
// and that the ledger half is byte-identical to plain getPortfolio().
test("getPortfolioReconciliation reports onChain:null and no syncDelta when there's no Trading Wallet yet", async () => {
    const ledgerOnly = tradingBotService.getPortfolio(userId);
    const reconciled = await tradingBotService.getPortfolioReconciliation(userId);
    assert.equal(reconciled.onChain, null);
    assert.equal(reconciled.syncDeltaUsd, null);
    assert.equal(reconciled.availableCash, ledgerOnly.availableCash);
    assert.equal(reconciled.equity, ledgerOnly.equity);
});

// Trust/UX sprint: tx_hash was a dead column on real trades (always
// NULL - executionService.execute() had the real signature in scope but
// never returned it). Proves getTrades() builds a real explorer link
// whenever a real hash is present, and stays honestly null otherwise.
test("getTrades() builds a real explorer URL when tx_hash is present, stays null otherwise", () => {

    db.prepare(`
        INSERT INTO trading_bot_trades (
            user_id, token_address, token_symbol, entry_price, exit_price, size_usd,
            roi_pct, fee_usd, slippage_pct, duration_seconds, reason, engine_version,
            opened_at, closed_at, tx_hash
        ) VALUES (?, 'TestTokenTxHash111', 'TXTEST', 1.0, 1.1, 10, 10, 0.2, 1, 60, 'SELL_MANUAL', 'production_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'RealTxHashAbc123')
    `).run(userId);

    db.prepare(`
        INSERT INTO trading_bot_trades (
            user_id, token_address, token_symbol, entry_price, exit_price, size_usd,
            roi_pct, fee_usd, slippage_pct, duration_seconds, reason, engine_version,
            opened_at, closed_at, tx_hash
        ) VALUES (?, 'TestTokenNoTxHash111', 'NOTX', 1.0, 1.1, 10, 10, 0.2, 1, 60, 'STOP_LOSS', 'production_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
    `).run(userId);

    const trades = tradingBotService.getTrades(userId, 10);
    const withHash = trades.find(t => t.txHash === "RealTxHashAbc123");
    const withoutHash = trades.find(t => t.tokenSymbol === "NOTX");

    assert.equal(withHash.txExplorerUrl, "https://explorer.solana.com/tx/RealTxHashAbc123");
    assert.equal(withoutHash.txHash, null);
    assert.equal(withoutHash.txExplorerUrl, null);

    // Section K (Trade History): real dollar profit, net of fees - size_usd
    // 10 * roi_pct 10% = 1, minus fee_usd 0.2 = 0.8. Same formula
    // sumClosedTrades() uses for the Portfolio's own realizedPnl.
    assert.equal(Number(withHash.profitUsd.toFixed(2)), 0.8);

});

test("getPositionDetail returns null for a nonexistent/other-user's position - never a fake row", () => {
    assert.equal(tradingBotService.getPositionDetail(userId, 999999999), null);
});

test("getPositionDetail reports hasBreakdown:false honestly for a position opened before the breakdown migration (legacy null)", () => {
    const positionId = insertTestOpenPosition(userId, "TestTokenDetailNoBreakdown111");
    const detail = tradingBotService.getPositionDetail(userId, positionId);
    assert.equal(detail.hasBreakdown, false);
    assert.deepEqual(detail.breakdown, null);
    assert.deepEqual(detail.reasons, []);
});

test("getPositionDetail surfaces a real persisted breakdown when one exists", () => {

    const positionId = insertTestOpenPosition(userId, "TestTokenDetailWithBreakdown111");
    const fakeBreakdown = { participant: { accumulation: { score: 10, max: 20, hasData: true } }, market: {} };
    db.prepare("UPDATE trading_bot_positions SET breakdown_json = ? WHERE id = ?").run(
        JSON.stringify({ breakdown: fakeBreakdown, reasons: ["Net accumulation detected"], acceleration: null }),
        positionId
    );

    const detail = tradingBotService.getPositionDetail(userId, positionId);
    assert.equal(detail.hasBreakdown, true);
    assert.deepEqual(detail.breakdown, fakeBreakdown);
    assert.deepEqual(detail.reasons, ["Net accumulation detected"]);

});

// Live Decision Center / Signal Center sprint: Strength/Weakness are the
// already-existing reasons/riskReasons, just honestly relabeled - and
// Confidence Breakdown is real read-only arithmetic over persisted
// participantScore/marketHealth, never a re-score.
test("getPositionDetail exposes Strength/Weakness and a real Confidence Breakdown when the full signal was persisted", () => {

    const positionId = insertTestOpenPosition(userId, "TestTokenSignalCenter111");
    db.prepare("UPDATE trading_bot_positions SET breakdown_json = ? WHERE id = ?").run(
        JSON.stringify({
            breakdown: { participant: {}, market: { liquidity: { score: 15, max: 20, hasData: true } } },
            reasons: ["Net accumulation detected"],
            riskReasons: ["Top 10 holders concentrated"],
            acceleration: { priceAccel: 0.5, flowAccel: 1.2, liquidityAccel: 0.1, gatePassed: true },
            participantScore: 70, participantMax: 100, marketHealth: 60, marketHealthMax: 100,
            freshnessPenalty: 2.5
        }),
        positionId
    );

    const detail = tradingBotService.getPositionDetail(userId, positionId);
    assert.deepEqual(detail.strength, ["Net accumulation detected"]);
    assert.deepEqual(detail.weakness, ["Top 10 holders concentrated"]);
    assert.equal(detail.flow, 1.2);
    assert.deepEqual(detail.liquidity, { score: 15, max: 20, hasData: true });

    assert.ok(detail.confidenceBreakdown, "confidenceBreakdown must be populated when participant/market scores were persisted");
    assert.equal(detail.confidenceBreakdown.participantPct, 70);
    assert.equal(detail.confidenceBreakdown.marketPct, 60);
    assert.equal(detail.confidenceBreakdown.freshnessPenalty, 2.5);
    assert.ok(detail.confidenceBreakdown.mismatchPenalty > 0); // real |70-60| mismatch, never zero when scores genuinely differ

});

// False Positive Reduction V2, Priority 5: a position opened AFTER this
// sprint persists its own real, full confidenceBreakdown (with
// completeness/risk penalties the old re-derivation could never see) plus
// missingEvidence and a real passReason narrative - all surfaced verbatim,
// never re-derived or guessed.
test("getPositionDetail prefers the persisted confidenceBreakdown and surfaces missingEvidence/passReason when present", () => {

    const positionId = insertTestOpenPosition(userId, "TestTokenEvidenceV2111");
    db.prepare("UPDATE trading_bot_positions SET breakdown_json = ? WHERE id = ?").run(
        JSON.stringify({
            breakdown: { participant: {}, market: {} },
            reasons: ["Net accumulation detected"],
            riskReasons: ["Snipers hold 32% of top holdings"],
            acceleration: null,
            participantScore: 62, participantMax: 100, marketHealth: 55, marketHealthMax: 100,
            freshnessPenalty: 0,
            missingEvidence: ["Smart-money trade activity", "KOL trade activity"],
            confidenceBreakdown: { value: 38, blended: 59, mismatchPenalty: 2.8, completenessPenalty: 12, freshnessPenalty: 0, riskPenalty: 8 },
            passReason: "Action tier BUY at participantScore 62/100. Confidence 38 (floor 45). Risk classified MEDIUM (HIGH is hard-rejected before a BUY can ever reach this point). Evidence not available for this token: Smart-money trade activity, KOL trade activity."
        }),
        positionId
    );

    const detail = tradingBotService.getPositionDetail(userId, positionId);

    assert.deepEqual(detail.missingEvidence, ["Smart-money trade activity", "KOL trade activity"]);
    assert.ok(detail.passReason.includes("participantScore 62/100"));
    assert.ok(detail.passReason.includes("Confidence 38 (floor 45)"));

    // The real persisted breakdown - including completeness/risk penalties
    // the old re-derivation-only path never had - must be used verbatim,
    // not silently recomputed into a thinner shape.
    assert.equal(detail.confidenceBreakdown.completenessPenalty, 12);
    assert.equal(detail.confidenceBreakdown.riskPenalty, 8);
    assert.equal(detail.confidenceBreakdown.mismatchPenalty, 2.8);
    assert.equal(detail.confidenceBreakdown.participantPct, 62);
    assert.equal(detail.confidenceBreakdown.marketPct, 55);

});

test("getPositionDetail reports missingEvidence: [] and passReason: null for a legacy position predating this sprint", () => {

    const positionId = insertTestOpenPosition(userId, "TestTokenEvidenceLegacy111");
    const detail = tradingBotService.getPositionDetail(userId, positionId);
    assert.deepEqual(detail.missingEvidence, []);
    assert.equal(detail.passReason, null);

});

test("getPositionDetail reports confidenceBreakdown: null and flow/liquidity: null for a legacy position with no persisted scores", () => {

    const positionId = insertTestOpenPosition(userId, "TestTokenSignalCenterLegacy111");
    const detail = tradingBotService.getPositionDetail(userId, positionId);
    assert.equal(detail.confidenceBreakdown, null);
    assert.equal(detail.flow, null);
    assert.equal(detail.liquidity, null);
    assert.deepEqual(detail.strength, []);
    assert.deepEqual(detail.weakness, []);

});

// Position Detail timeline: a real trade row, joined via migration 049's
// position_id FK - never guessed from token_address/opened_at.
test("getPositionDetail's timeline surfaces the real closing trade once a position is closed", () => {

    const positionId = insertTestOpenPosition(userId, "TestTokenTimeline111");
    let position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);

    const openDetail = tradingBotService.getPositionDetail(userId, positionId);
    assert.equal(openDetail.timeline.exit, null, "no exit yet - position still open");
    assert.equal(openDetail.timeline.current.price, position.current_price);
    assert.equal(openDetail.timeline.sell, null);

    tradingBotRepository.closePosition(userId, position, {
        exitPrice: 1.15, roiPct: 15, feeUsd: 0.2, slippagePct: 0, durationSeconds: 120, reason: "SELL_MANUAL"
    });

    const closedDetail = tradingBotService.getPositionDetail(userId, positionId);
    assert.ok(closedDetail.timeline.exit, "a real trade row must now be joined");
    assert.equal(closedDetail.timeline.exit.price, 1.15);
    assert.equal(closedDetail.timeline.exit.reason, "SELL_MANUAL");
    assert.ok(closedDetail.timeline.sell.at);
    assert.equal(closedDetail.timeline.current, null); // no longer OPEN - no "current price" stage

});

// Live Decision Center: an account with no bot activity yet must report
// honest "nothing happened" states, never fabricated queues/metrics.
test("getDecisionCenter reports honest empty/unconfigured states for a fresh account with no cycle yet", async () => {

    const detail = await tradingBotService.getDecisionCenter(userId);
    assert.deepEqual(detail.buyQueue, []);
    assert.deepEqual(detail.waitQueue, []);
    assert.deepEqual(detail.avoidSample, []);
    assert.equal(detail.currentOpportunity, null);
    assert.equal(detail.walletStatus, "NOT_CONFIGURED"); // account-specific - this fresh test user has no Trading Wallet
    // rpcStatus reflects real, environment-wide RPC configuration (not
    // per-account), so it's not faked here either way - just assert it's
    // one of the real, honest states this function can report.
    assert.ok(["NOT_CONFIGURED", "CONNECTED", "UNAVAILABLE"].includes(detail.rpcStatus));
    assert.equal(detail.lastCycleAt, null);

});

test("getDecisionCenter surfaces a real, bounded queue once a cycle has run", async () => {

    tradingBotRepository.replaceDecisionSnapshot(userId, [
        { tokenAddress: "DC_BUY_1", tokenSymbol: "DCB", action: "STRONG BUY", confidence: 80, risk: "LOW", tier: "HEATING", rank: 0, priorityScore: 90, reasons: ["Net accumulation"] },
        { tokenAddress: "DC_WAIT_1", tokenSymbol: "DCW", action: "HOLD", confidence: 45, risk: "MEDIUM", tier: null, rank: null, priorityScore: null, reasons: [] }
    ]);
    tradingBotRepository.insertLog(userId, { logType: "SYSTEM", message: "Filtering: 1 qualified (BUY/STRONG BUY) of 2 scanned.", meta: { qualifiedCount: 1, holdCount: 1, avoidCount: 0, scanned: 2 } });
    tradingBotRepository.insertLog(userId, { logType: "SYSTEM", message: "Ranking: top candidate is DCB at rank #1 (priority 90).", meta: {} });
    tradingBotRepository.insertLog(userId, { logType: "SYSTEM", message: "Cycle complete: scanned 2, opened 0, closed 0, skipped 2." });

    const detail = await tradingBotService.getDecisionCenter(userId);
    assert.equal(detail.buyQueue.length, 1);
    assert.equal(detail.buyQueue[0].tokenAddress, "DC_BUY_1");
    assert.deepEqual(detail.buyQueue[0].reasons, ["Net accumulation"]);
    assert.equal(detail.waitQueue.length, 1);
    assert.equal(detail.currentOpportunity.tokenAddress, "DC_BUY_1");
    assert.equal(detail.qualifiedCandidateCount, 1);
    assert.equal(detail.holdCount, 1);
    assert.ok(detail.lastCycleAt);

});

// Fresh, disposable user for both getMomentumKpi tests below - the
// shared `userId` fixture already has real trades from the
// forceSellAll/sellPosition tests earlier in this file by this point, so
// it can't honestly demonstrate the "zero trades yet" state.
test("getMomentumKpi reports an honest zero/null state with no fabricated scores when no trades exist", () => {

    const testEmail = `tradingbotservice.test.kpi.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const kpiUserId = registerResult.userId;

    try{
        const kpi = tradingBotService.getMomentumKpi(kpiUserId);
        assert.equal(kpi.totalTrades, 0);
        assert.equal(kpi.avgHoldingTimeSeconds, null);
        assert.equal(kpi.tradesPerHour, null);
        assert.equal(kpi.avgRankAtEntry, null);
        assert.equal(kpi.avgTimeToSellSeconds, null);
        // Explicitly deferred metrics - never a fabricated score
        assert.equal(kpi.entryTimingScore, null);
        assert.equal(kpi.momentumCaptureScore, null);
        assert.equal(kpi.missedOpportunityPct, null);
        assert.ok(kpi.deferredMetricsReason);
    }
    finally{
        deleteTestUser(kpiUserId);
    }

});

test("getMomentumKpi computes real holding time/throughput and a real avgRankAtEntry once trades exist", () => {

    const testEmail = `tradingbotservice.test.kpi.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const kpiUserId = registerResult.userId;

    try{
        const positionId = insertTestOpenPosition(kpiUserId, "TestTokenKpi111");
        db.prepare("UPDATE trading_bot_positions SET rank_at_entry = 2 WHERE id = ?").run(positionId);
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);

        // Production Hotfix V1.1, Section 5: getMomentumKpi is now
        // LIVE-only (Founder Live Trading evaluation must never count a
        // SIMULATION-mode paper trade) - a fake but real-shaped
        // closeExecutionId is what marks this as a genuine LIVE close.
        tradingBotRepository.closePosition(kpiUserId, position, {
            exitPrice: 1.1, roiPct: 10, feeUsd: 0.1, slippagePct: 0, durationSeconds: 600, reason: "SELL_MANUAL", closeExecutionId: 999001
        });

        const kpi = tradingBotService.getMomentumKpi(kpiUserId);
        assert.equal(kpi.totalTrades, 1);
        assert.equal(kpi.avgHoldingTimeSeconds, 600);
        assert.equal(kpi.avgRankAtEntry, 2);
        assert.ok(kpi.tradesPerHour > 0);
        // avgTimeToSellSeconds measures a different, narrower real-execution
        // timing signal not populated by this fixture - honestly N/A, not zero
        assert.equal(kpi.avgTimeToSellSeconds, null);
        assert.equal(kpi.avgTimeToSellSampleSize, 0);
    }
    finally{
        deleteTestUser(kpiUserId);
    }

});

// Momentum Validation System sprint: real Average Entry Delay (candidate
// sightings first_seen_at vs. the position's real opened_at) and real
// Average Time To Peak (mfe_at vs. opened_at) - both computed only for
// positions with the matching real data, never guessed for the rest.
test("getMomentumKpi computes a real avgEntryDelaySeconds and avgTimeToPeakSeconds from real sightings/mfe_at data", () => {

    const testEmail = `tradingbotservice.test.kpi.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const kpiUserId = registerResult.userId;
    const tokenAddress = "TestTokenEntryDelay111";

    try{
        // Sighting first, 15 real minutes ago; position opened 10 minutes
        // ago (5-minute real entry delay); real peak reached 3 minutes ago
        // (7-minute real time-to-peak) - all strictly chronological.
        tradingBotCandidateSightingsRepository.recordSighting(kpiUserId, { tokenAddress, tokenSymbol: "DLY", entryPrice: 1.0 });
        db.prepare("UPDATE trading_bot_candidate_sightings SET first_seen_at = datetime('now', '-15 minutes') WHERE user_id = ? AND token_address = ?")
            .run(kpiUserId, tokenAddress);

        const positionId = insertTestOpenPosition(kpiUserId, tokenAddress);
        // Production Hotfix V1.1, Section 5: findEntryDelayValues/
        // findTimeToPeakValues are now LIVE-only (position.execution_id
        // IS NOT NULL) - a fake but real-shaped id marks this fixture as
        // a genuine LIVE position, matching what this test means to prove.
        db.prepare("UPDATE trading_bot_positions SET opened_at = datetime('now', '-10 minutes'), mfe_pct = 15, mfe_at = datetime('now', '-3 minutes'), execution_id = 999002 WHERE id = ?").run(positionId);

        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        tradingBotRepository.closePosition(kpiUserId, position, {
            exitPrice: 1.15, roiPct: 15, feeUsd: 0.1, slippagePct: 0, durationSeconds: 300, reason: "MOMENTUM_WEAKENING", closeExecutionId: 999003
        });

        const kpi = tradingBotService.getMomentumKpi(kpiUserId);
        assert.ok(kpi.avgEntryDelaySeconds > 250 && kpi.avgEntryDelaySeconds < 350, `expected ~300s entry delay, got ${kpi.avgEntryDelaySeconds}`);
        assert.ok(kpi.avgTimeToPeakSeconds > 370 && kpi.avgTimeToPeakSeconds < 470, `expected ~420s time to peak, got ${kpi.avgTimeToPeakSeconds}`);

    }
    finally{
        deleteTestUser(kpiUserId);
    }

});

// Missed Winners page (Momentum Validation System sprint, this sprint's
// own stated top priority): only real, SETTLED outcomes ever appear -
// a still-pending row (outcome not yet evaluated) must never show up
// with a fake "..." placeholder.
test("getMissedWinners returns only real, evaluated outcomes - a still-pending row never appears", () => {

    const testEmail = `tradingbotservice.test.missed.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const missedUserId = registerResult.userId;

    try{
        tradingBotMissedOpportunityRepository.upsertPending(missedUserId, {
            tokenAddress: "MissedWinnerEvaluated111", tokenSymbol: "MWE", rankAtSkip: 3, priorityScoreAtSkip: 70,
            reason: "MAX_OPEN_POSITIONS_REACHED", priceAtSkip: 1.0
        });
        const evaluatedRow = db.prepare("SELECT id FROM trading_bot_missed_opportunity WHERE user_id = ? AND token_address = ?").get(missedUserId, "MissedWinnerEvaluated111");
        tradingBotMissedOpportunityRepository.fillOutcome(evaluatedRow.id, { outcomePrice: 2.43, outcomeReturnPct: 143 });

        tradingBotMissedOpportunityRepository.upsertPending(missedUserId, {
            tokenAddress: "MissedWinnerPending111", tokenSymbol: "MWP", rankAtSkip: 1, priorityScoreAtSkip: 90,
            reason: "CONFIDENCE_BELOW_FLOOR", priceAtSkip: 1.0
        });

        const winners = tradingBotService.getMissedWinners(missedUserId, 50);
        assert.equal(winners.length, 1, "the still-pending row must not appear");
        assert.equal(winners[0].tokenAddress, "MissedWinnerEvaluated111");
        assert.equal(winners[0].outcomeReturnPct, 143);
        assert.equal(winners[0].hasOutcome, true);

    }
    finally{
        deleteTestUser(missedUserId);
    }

});

// Self-Comparison (Momentum Validation System sprint): a real sibling
// captured at buy time gets a real, on-demand comparative outcome from
// token_price_history - never a stored background job, never fabricated
// when no real price data exists for the sibling.
test("getPositionDetail computes a real, on-demand sibling comparison from real price history", () => {

    const testEmail = `tradingbotservice.test.sibling.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const siblingUserId = registerResult.userId;
    const siblingTokenAddress = "SiblingCompareToken111";

    try{
        const positionId = insertTestOpenPosition(siblingUserId, "PositionWithSiblingToken111");
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);

        db.prepare("UPDATE trading_bot_positions SET siblings_json = ?, mfe_pct = ? WHERE id = ?").run(
            JSON.stringify([{ tokenAddress: siblingTokenAddress, tokenSymbol: "SIBC", rank: 1, priorityScore: 85 }]),
            10, // this position's own real best ROI so far: +10%
            positionId
        );

        // Real price history for the sibling, starting at/after this
        // position's own opened_at - baseline 1.0, real peak 1.5 (+50%,
        // genuinely outperforming this position's +10%).
        tokenPriceHistoryRepository.insertMany([
            { tokenAddress: siblingTokenAddress, price: 1.0, marketCap: null, liquidity: null },
            { tokenAddress: siblingTokenAddress, price: 1.5, marketCap: null, liquidity: null },
            { tokenAddress: siblingTokenAddress, price: 1.3, marketCap: null, liquidity: null }
        ]);

        const detail = tradingBotService.getPositionDetail(siblingUserId, positionId);
        assert.equal(detail.siblings.length, 1);
        assert.equal(detail.siblings[0].tokenAddress, siblingTokenAddress);
        assert.equal(Math.round(detail.siblings[0].outcomeReturnPct), 50);
        assert.equal(detail.siblings[0].outperformed, true);

    }
    finally{
        db.prepare("DELETE FROM token_price_history WHERE token_address = ?").run(siblingTokenAddress);
        deleteTestUser(siblingUserId);
    }

});

test("getPositionDetail reports siblings: [] for a position with no siblings_json recorded", () => {
    const positionId = insertTestOpenPosition(userId, "PositionNoSiblings111");
    const detail = tradingBotService.getPositionDetail(userId, positionId);
    assert.deepEqual(detail.siblings, []);
});

// Self-Audit / Performance Report (Momentum Validation System sprint):
// real TP/SL/Dynamic-Exit/Manual/External categorization, zero new
// engine logic - a GROUP BY of already-real trading_bot_trades.reason
// values, scoped to a real rolling window.
test("getSelfAudit categorizes real close reasons correctly and reports honest zero counts outside the window", () => {

    const testEmail = `tradingbotservice.test.audit.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const auditUserId = registerResult.userId;

    // Production Hotfix V1.1, Section 5: getSelfAudit's underlying
    // findTradesClosedSince is now LIVE-only (close_execution_id IS NOT
    // NULL) - every trade this helper closes needs a fake but
    // real-shaped closeExecutionId to count, matching what this test
    // means to prove about real trading activity.
    let fakeExecutionIdSeq = 999100;
    function openAndClose(tokenAddress, reason, roiPct, rankAtEntry){
        const positionId = tradingBotRepository.insertPosition(auditUserId, {
            tokenAddress, tokenSymbol: "AUD", entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.2, targetMarketCap: null, stopLossPrice: 0.9, stopLossMarketCap: null,
            rankAtEntry
        });
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        tradingBotRepository.closePosition(auditUserId, position, {
            exitPrice: 1 + roiPct / 100, roiPct, feeUsd: 0.1, slippagePct: 0, durationSeconds: 300, reason, closeExecutionId: fakeExecutionIdSeq++
        });
    }

    try{

        openAndClose("AuditTP111", "MOMENTUM_WEAKENING", 20, 1); // roi >= 15 -> TP
        openAndClose("AuditDynExit111", "MOMENTUM_WEAKENING", 5, 2); // roi < 15 -> Dynamic Exit
        openAndClose("AuditReversal111", "REVERSAL", -2, null);
        openAndClose("AuditSL111", "STOP_LOSS", -12, null);
        openAndClose("AuditManual111", "SELL_MANUAL", 3, null);
        openAndClose("AuditNoBalance111", "STOP_LOSS_NO_REAL_BALANCE", -10, null); // suffix stripped -> SL, not its own bucket

        // One more trade, manually backdated 48h - must be excluded from
        // a 24h window but included in a 72h one, proving the window is
        // real time-scoping, not just "everything ever".
        openAndClose("AuditOld111", "SELL_MANUAL", 8, null);
        db.prepare("UPDATE trading_bot_trades SET closed_at = datetime('now', '-48 hours') WHERE user_id = ? AND token_address = ?").run(auditUserId, "AuditOld111");

        const audit = tradingBotService.getSelfAudit(auditUserId, 24);
        assert.equal(audit.closed, 6, "the 48h-old trade must not be counted in a 24h window");
        assert.equal(audit.tp, 1);
        assert.equal(audit.dynamicExit, 2); // MOMENTUM_WEAKENING<15 + REVERSAL
        assert.equal(audit.sl, 2); // STOP_LOSS + the _NO_REAL_BALANCE-suffixed one
        assert.equal(audit.manual, 1);
        assert.equal(audit.avgEntryRank, 1.5); // real average of the two recorded rank_at_entry values (1, 2)

        const auditWide = tradingBotService.getSelfAudit(auditUserId, 72);
        assert.equal(auditWide.closed, 7, "a wider window must include the 48h-old trade");
        assert.equal(auditWide.manual, 2);

    }
    finally{
        deleteTestUser(auditUserId);
    }

});

// Phase 2 (Live Validation & Bottleneck Elimination): getSelfAudit's
// windowed Average Entry Delay and Missed Winner count must correctly
// exclude a real event that happened outside the requested window.
test("getSelfAudit reports a windowed avgEntryDelaySeconds and missedWinnerCount, excluding out-of-window events", () => {

    const testEmail = `tradingbotservice.test.audit2.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const auditUserId = registerResult.userId;
    const tokenAddress = "AuditEntryDelayToken111";

    try{

        // Real sighting 10 minutes before a real position opens (600s delay).
        tradingBotCandidateSightingsRepository.recordSighting(auditUserId, { tokenAddress, tokenSymbol: "AED", entryPrice: 1.0 });
        db.prepare("UPDATE trading_bot_candidate_sightings SET first_seen_at = datetime('now', '-10 minutes') WHERE user_id = ? AND token_address = ?")
            .run(auditUserId, tokenAddress);
        const positionId = insertTestOpenPosition(auditUserId, tokenAddress);
        // Production Hotfix V1.1, Section 5: findEntryDelayValuesSince is
        // now LIVE-only (position.execution_id IS NOT NULL).
        db.prepare("UPDATE trading_bot_positions SET execution_id = 999200 WHERE id = ?").run(positionId);

        // A real, evaluated missed-opportunity outcome, well inside a 24h window.
        tradingBotMissedOpportunityRepository.upsertPending(auditUserId, {
            tokenAddress: "AuditMissedWinnerToken111", tokenSymbol: "AMW", rankAtSkip: 2, priorityScoreAtSkip: 70,
            reason: "MAX_OPEN_POSITIONS_REACHED", priceAtSkip: 1.0
        });
        const missedRow = db.prepare("SELECT id FROM trading_bot_missed_opportunity WHERE user_id = ? AND token_address = ?").get(auditUserId, "AuditMissedWinnerToken111");
        tradingBotMissedOpportunityRepository.fillOutcome(missedRow.id, { outcomePrice: 2.0, outcomeReturnPct: 100 });

        // A second missed-opportunity outcome, manually backdated outside a 24h window.
        tradingBotMissedOpportunityRepository.upsertPending(auditUserId, {
            tokenAddress: "AuditMissedWinnerOldToken111", tokenSymbol: "AMWO", rankAtSkip: 1, priorityScoreAtSkip: 90,
            reason: "CONFIDENCE_BELOW_FLOOR", priceAtSkip: 1.0
        });
        db.prepare("UPDATE trading_bot_missed_opportunity SET skipped_at = datetime('now', '-48 hours') WHERE user_id = ? AND token_address = ?")
            .run(auditUserId, "AuditMissedWinnerOldToken111");
        const oldMissedRow = db.prepare("SELECT id FROM trading_bot_missed_opportunity WHERE user_id = ? AND token_address = ?").get(auditUserId, "AuditMissedWinnerOldToken111");
        tradingBotMissedOpportunityRepository.fillOutcome(oldMissedRow.id, { outcomePrice: 3.0, outcomeReturnPct: 200 });

        const audit = tradingBotService.getSelfAudit(auditUserId, 24);
        assert.ok(audit.avgEntryDelaySeconds > 550 && audit.avgEntryDelaySeconds < 650, `expected ~600s, got ${audit.avgEntryDelaySeconds}`);
        assert.equal(audit.missedWinnerCount, 1, "the 48h-old missed-winner outcome must not be counted in a 24h window");

        const auditWide = tradingBotService.getSelfAudit(auditUserId, 72);
        assert.equal(auditWide.missedWinnerCount, 2, "a wider window must include both missed-winner outcomes");

    }
    finally{
        deleteTestUser(auditUserId);
    }

});

// System Throughput (Phase 2): real Average Simultaneous Position / Idle
// Cash from real per-cycle samples (migration 054), real per-hour rates
// from real trades, and real Capital Utilization from getPortfolio().
test("getSystemThroughput computes real per-cycle averages and per-hour rates from real data", () => {

    const testEmail = `tradingbotservice.test.throughput.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const throughputUserId = registerResult.userId;

    try{

        // Two real per-cycle samples (migration 054's columns).
        tradingBotRepository.insertEquitySnapshot(throughputUserId, 100, 2, 30);
        tradingBotRepository.insertEquitySnapshot(throughputUserId, 105, 4, 10);

        // One real closed trade. Production Hotfix V1.1, Section 5:
        // findTradesClosedSince is now LIVE-only.
        const positionId = insertTestOpenPosition(throughputUserId, "ThroughputToken111");
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        tradingBotRepository.closePosition(throughputUserId, position, {
            exitPrice: 1.1, roiPct: 10, feeUsd: 0.1, slippagePct: 0, durationSeconds: 900, reason: "SELL_MANUAL", closeExecutionId: 999300
        });

        // One real cycle-summary log row with a real qualifiedCount.
        tradingBotRepository.insertLog(throughputUserId, { logType: "SYSTEM", message: "Filtering: 5 qualified (BUY/STRONG BUY) of 100 scanned.", meta: { qualifiedCount: 5, scanned: 100 } });

        const throughput = tradingBotService.getSystemThroughput(throughputUserId, 24);
        assert.equal(throughput.avgSimultaneousPosition, 3); // real average of (2, 4)
        assert.equal(throughput.avgIdleCash, 20); // real average of (30, 10)
        assert.equal(throughput.avgPositionDurationSeconds, 900);
        assert.ok(throughput.closePositionPerHour > 0);
        assert.equal(throughput.avgCandidatePerCycle, 5);
        assert.equal(throughput.avgQueueLength, 5); // same real number, the phase's other name for it
        assert.ok(throughput.capitalUtilizationPct != null);

    }
    finally{
        deleteTestUser(throughputUserId);
    }

});

// Bottleneck Report (Phase 2): real counts + a real cause-percentage
// breakdown, in the Founder's own vocabulary - built from real
// missed-opportunity rows, never an invented category.
test("getBottleneckReport computes real counts and a real cause-percentage breakdown", () => {

    const testEmail = `tradingbotservice.test.bottleneck.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const bnUserId = registerResult.userId;

    try{
        // Real open position (counted by countOpenPositions).
        insertTestOpenPosition(bnUserId, "BottleneckOpenToken111");

        // Real missed-opportunity rows across 3 different real categories.
        tradingBotMissedOpportunityRepository.upsertPending(bnUserId, {
            tokenAddress: "BN_Slot111", tokenSymbol: "BNS", rankAtSkip: 1, priorityScoreAtSkip: 80,
            reason: "MAX_OPEN_POSITIONS_REACHED", priceAtSkip: 1.0
        });
        tradingBotMissedOpportunityRepository.upsertPending(bnUserId, {
            tokenAddress: "BN_Cash111", tokenSymbol: "BNC", rankAtSkip: 2, priorityScoreAtSkip: 75,
            reason: "INSUFFICIENT_AVAILABLE_CASH", priceAtSkip: 1.0
        });
        tradingBotMissedOpportunityRepository.upsertPending(bnUserId, {
            tokenAddress: "BN_Rank111", tokenSymbol: "BNR", rankAtSkip: 3, priorityScoreAtSkip: 60,
            reason: "SLOT_FULL_BEFORE_TURN", priceAtSkip: 1.0
        });

        const report = tradingBotService.getBottleneckReport(bnUserId, 24);
        assert.equal(report.openPosition, 1);
        assert.equal(report.totalMissedOpportunities, 3);

        // Fresh BUY Universe RFC, pipeline observability enhancement: the
        // report always carries this shape, even with zero fresh-universe
        // snapshots recorded in the window - tick-global data, never
        // guessed/defaulted to a fabricated number.
        assert.ok("freshUniverse" in report);
        assert.ok("tickCount" in report.freshUniverse);
        assert.ok("collectorTotalAvg" in report.freshUniverse);
        assert.ok("freshUniverseAvg" in report.freshUniverse);
        assert.ok("droppedPct" in report.freshUniverse);

        const slotCause = report.causes.find(c => c.category === "OPEN_SLOT_FULL");
        assert.ok(slotCause, "OPEN_SLOT_FULL must aggregate both MAX_OPEN_POSITIONS_REACHED and SLOT_FULL_BEFORE_TURN");
        assert.equal(slotCause.count, 2);
        assert.equal(Math.round(slotCause.pct), 67);

        const cashCause = report.causes.find(c => c.category === "TRADING_BALANCE_HABIS");
        assert.equal(cashCause.count, 1);

        assert.equal(report.executionFailureCount, 0);
        assert.equal(report.latestExecutionError, null);

    }
    finally{
        deleteTestUser(bnUserId);
    }

});

// Fresh BUY Universe RFC, pipeline observability enhancement: proves
// getBottleneckReport's freshUniverse block correctly surfaces the
// collector->fresh-universe funnel stage. Stubbed (not real inserts) -
// trading_bot_fresh_universe_snapshots is tick-global, not user-scoped,
// so unlike this file's other real-DB tests there is no per-test-user
// row to clean up afterward via deleteTestUser.
test("getBottleneckReport surfaces the fresh-universe funnel stage from tradingBotFreshUniverseSnapshotRepository", () => {

    const restoreSumSince = stub(tradingBotFreshUniverseSnapshotRepository, "sumSince", (hours) => {
        assert.equal(hours, 24);
        return { tickCount: 4, collectorTotalAvg: 14023, freshUniverseAvg: 351 };
    });

    try{
        const report = tradingBotService.getBottleneckReport(userId, 24);
        assert.deepEqual(report.freshUniverse, {
            tickCount: 4,
            collectorTotalAvg: 14023,
            freshUniverseAvg: 351,
            droppedPct: 97.5 // (14023 - 351) / 14023 * 100, rounded to 1 decimal
        });
    }
    finally{
        restoreSumSince();
    }

});

// Target Achievement summary (Phase 2's own explicit deliverable): must
// assemble the real numbers, never assert its own "yes"/"no" verdict.
test("getTargetAchievementSummary assembles real numbers under the phase's four questions, without a self-issued verdict", () => {
    const summary = tradingBotService.getTargetAchievementSummary(userId, 24);
    assert.ok("openPositionPerHour" in summary.manyOpenPositions);
    assert.ok("closePositionPerHour" in summary.manyClosePositions);
    assert.ok("avgEntryDelaySeconds" in summary.fastEntry);
    assert.ok("avgTimeToPeakSeconds" in summary.noMomentumLoss);
    assert.ok(!("verdict" in summary) && !("achieved" in summary), "must never self-issue a yes/no judgment - that's reserved for the Founder");
});

test.after(() => {
    // Leave the dev database exactly as this suite found it - restore
    // STABLE (this project's real default, Final Spec section 04) and
    // remove the disposable test user/bot rows this suite created.
    tradingBotService.updateConfig(userId, { strategy_profile: "STABLE" });
    deleteTestUser(userId);
});

// Section J (Open Position fields): SL/TP must be the position's own
// real stored risk bands, dynamicState must reflect real ROI vs the
// real MIN_TP_PCT floor, and priceUpdatedAt/nextEvaluationAtEstimate
// must be real/derived, never fabricated.
test("getOpenPositions surfaces real SL/TP, a real dynamicState, and a real priceUpdatedAt-derived next evaluation estimate", async () => {

    const testEmail = `tradingbotservice.test.openpos.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const opUserId = registerResult.userId;

    try{

        const belowTargetId = tradingBotRepository.insertPosition(opUserId, {
            tokenAddress: "TestOpenPosBelow111", tokenSymbol: "BELOW",
            entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.15, targetMarketCap: null, stopLossPrice: 0.85, stopLossMarketCap: null
        });
        // +5% - real ROI, still below the real MIN_TP_PCT (Arjuna V3: 25) floor.
        tradingBotRepository.updatePositionTracking(belowTargetId, { currentPrice: 1.05, mfePct: 5, maePct: 0, lastVolume1h: null });

        const trailingId = tradingBotRepository.insertPosition(opUserId, {
            tokenAddress: "TestOpenPosTrailing111", tokenSymbol: "TRAIL",
            entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.15, targetMarketCap: null, stopLossPrice: 0.85, stopLossMarketCap: null
        });
        // +30% - real ROI, above the real MIN_TP_PCT floor.
        tradingBotRepository.updatePositionTracking(trailingId, { currentPrice: 1.30, mfePct: 30, maePct: 0, lastVolume1h: null });

        const positions = tradingBotService.getOpenPositions(opUserId);
        const below = positions.find(p => p.id === belowTargetId);
        const trailing = positions.find(p => p.id === trailingId);

        assert.equal(below.stopLossPrice, 0.85);
        assert.equal(below.targetPrice, 1.15);
        assert.equal(below.dynamicState, "BELOW_TARGET");
        assert.ok(below.priceUpdatedAt, "priceUpdatedAt must be a real timestamp once updatePositionTracking has run");
        assert.ok(below.nextEvaluationAtEstimate, "must be a real, derived estimate, not null, once priceUpdatedAt exists");
        assert.ok(new Date(below.nextEvaluationAtEstimate).getTime() > new Date(below.priceUpdatedAt.replace(" ", "T") + "Z").getTime());

        assert.equal(trailing.dynamicState, "TRAILING_ABOVE_TARGET");

    }
    finally{
        deleteTestUser(opUserId);
    }

});

// Production Hotfix V1.1, Section 5: a SIMULATION-mode paper trade must
// never count toward Momentum KPI / Self-Audit / System Throughput
// (Founder Live Trading evaluation surfaces), while a real LIVE trade
// does - both trades are otherwise identical (same ROI, same reason).
test("a SIMULATION trade never counts toward Momentum KPI/Self-Audit, a LIVE trade does", () => {

    const testEmail = `tradingbotservice.test.simsep.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        // A SIMULATION trade - no execution_id anywhere, exactly what a
        // real paper trade (or a stray position auto-closed on a
        // SIMULATION->LIVE mode switch, see Production Stabilization V1's
        // own validation report) looks like.
        const simPositionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestSimSepSim111", tokenSymbol: "SIMSEP", entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.2, targetMarketCap: null, stopLossPrice: 0.9, stopLossMarketCap: null
        });
        const simPosition = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(simPositionId);
        tradingBotRepository.closePosition(userId, simPosition, {
            exitPrice: 0.5, roiPct: -50, feeUsd: 0.1, slippagePct: 0, durationSeconds: 300, reason: "SELL_EXTERNAL"
        });

        // A real LIVE trade - a real (if fake-numbered, for this test)
        // execution_id on both the position and the close.
        const livePositionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestSimSepLive111", tokenSymbol: "LIVESEP", entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.2, targetMarketCap: null, stopLossPrice: 0.9, stopLossMarketCap: null,
            executionId: 999400
        });
        const livePosition = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(livePositionId);
        tradingBotRepository.closePosition(userId, livePosition, {
            exitPrice: 1.1, roiPct: 10, feeUsd: 0.1, slippagePct: 0, durationSeconds: 300, reason: "SELL_MANUAL", closeExecutionId: 999401
        });

        const kpi = tradingBotService.getMomentumKpi(userId);
        assert.equal(kpi.totalTrades, 1, "only the LIVE trade counts toward Momentum KPI");

        const audit = tradingBotService.getSelfAudit(userId, 24);
        assert.equal(audit.closed, 1, "only the LIVE trade counts toward Self-Audit");
        assert.equal(audit.manual, 1);
        assert.equal(audit.external, 0, "the SIMULATION SELL_EXTERNAL close must not be counted at all, real or otherwise");

        // Trade History (the LIST view) still shows BOTH, but each row is
        // now clearly labeled - nothing is hidden, just never blended
        // unlabeled into an aggregate.
        const trades = tradingBotService.getTrades(userId, 10);
        const simRow = trades.find(t => t.tokenSymbol === "SIMSEP");
        const liveRow = trades.find(t => t.tokenSymbol === "LIVESEP");
        assert.equal(simRow.mode, "SIMULATION");
        assert.equal(liveRow.mode, "LIVE");

    }
    finally{
        deleteTestUser(userId);
    }

});
