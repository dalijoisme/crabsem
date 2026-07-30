// scheduler/missedOpportunityOutcomeScheduler.test.js - Momentum
// Validation System sprint. Proves runOnce() fills in a real outcome
// (real peak price since the skip, from token_price_history - zero new
// GMGN polling) for a pending row past its horizon, leaves a row still
// within the horizon untouched, and honestly marks a row with no real
// price data as "evaluated, no data" rather than leaving it pending
// forever once MAX_WAIT_HOURS has passed. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { runOnce, OUTCOME_HORIZON_HOURS, MAX_WAIT_HOURS } = require("./missedOpportunityOutcomeScheduler");
const tradingBotMissedOpportunityRepository = require("../repositories/tradingBotMissedOpportunityRepository");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");
const userAuthService = require("../services/userAuthService");
const db = require("../database/connection");

function deleteTestUser(id){
    db.prepare("DELETE FROM trading_bot_missed_opportunity WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

function hoursAgoTimestamp(hours){
    return new Date(Date.now() - hours * 3600000).toISOString().slice(0, 19).replace("T", " ");
}

test("runOnce fills a real outcome (peak since skip) for a pending row past the horizon, and leaves a fresh row untouched", async () => {

    const testEmail = `missedoutcome.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    const oldTokenAddress = `MissedOutcomeOld${crypto.randomBytes(4).toString("hex")}`;
    const freshTokenAddress = `MissedOutcomeFresh${crypto.randomBytes(4).toString("hex")}`;

    try{

        // Old-enough pending row (skipped_at well past OUTCOME_HORIZON_HOURS)
        tradingBotMissedOpportunityRepository.upsertPending(userId, {
            tokenAddress: oldTokenAddress, tokenSymbol: "OLD", rankAtSkip: 2, priorityScoreAtSkip: 80,
            reason: "MAX_OPEN_POSITIONS_REACHED", priceAtSkip: 1.0
        });
        db.prepare("UPDATE trading_bot_missed_opportunity SET skipped_at = ? WHERE user_id = ? AND token_address = ?")
            .run(hoursAgoTimestamp(OUTCOME_HORIZON_HOURS + 1), userId, oldTokenAddress);

        // Real price history since the skip - a genuine peak of 2.5 (+150%)
        tokenPriceHistoryRepository.insertMany([
            { tokenAddress: oldTokenAddress, price: 1.2, marketCap: null, liquidity: null },
            { tokenAddress: oldTokenAddress, price: 2.5, marketCap: null, liquidity: null },
            { tokenAddress: oldTokenAddress, price: 2.0, marketCap: null, liquidity: null }
        ]);

        // Fresh pending row - still within the horizon, must NOT be touched
        tradingBotMissedOpportunityRepository.upsertPending(userId, {
            tokenAddress: freshTokenAddress, tokenSymbol: "FRESH", rankAtSkip: 1, priorityScoreAtSkip: 90,
            reason: "CONFIDENCE_BELOW_FLOOR", priceAtSkip: 1.0
        });

        await runOnce();

        const oldRow = db.prepare("SELECT * FROM trading_bot_missed_opportunity WHERE user_id = ? AND token_address = ?").get(userId, oldTokenAddress);
        assert.ok(oldRow.outcome_evaluated_at, "the old, past-horizon row must be evaluated");
        assert.equal(oldRow.outcome_price, 2.5);
        assert.equal(Math.round(oldRow.outcome_return_pct), 150);

        const freshRow = db.prepare("SELECT * FROM trading_bot_missed_opportunity WHERE user_id = ? AND token_address = ?").get(userId, freshTokenAddress);
        assert.equal(freshRow.outcome_evaluated_at, null, "a row still within the horizon must not be evaluated yet");

    }
    finally{
        db.prepare("DELETE FROM token_price_history WHERE token_address = ?").run(oldTokenAddress);
        deleteTestUser(userId);
    }

});

test("runOnce honestly marks a row as evaluated with a null outcome once MAX_WAIT_HOURS passes with no real price data", async () => {

    const testEmail = `missedoutcome.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    const staleTokenAddress = `MissedOutcomeStale${crypto.randomBytes(4).toString("hex")}`;

    try{

        tradingBotMissedOpportunityRepository.upsertPending(userId, {
            tokenAddress: staleTokenAddress, tokenSymbol: "STALE", rankAtSkip: 4, priorityScoreAtSkip: 55,
            reason: "COOLDOWN_ACTIVE_LOSS", priceAtSkip: 1.0
        });
        db.prepare("UPDATE trading_bot_missed_opportunity SET skipped_at = ? WHERE user_id = ? AND token_address = ?")
            .run(hoursAgoTimestamp(MAX_WAIT_HOURS + 1), userId, staleTokenAddress);

        // Deliberately no token_price_history rows for this token at all.
        await runOnce();

        const row = db.prepare("SELECT * FROM trading_bot_missed_opportunity WHERE user_id = ? AND token_address = ?").get(userId, staleTokenAddress);
        assert.ok(row.outcome_evaluated_at, "must stop waiting and settle once MAX_WAIT_HOURS has passed");
        assert.equal(row.outcome_price, null, "never a fabricated price when no real data ever appeared");
        assert.equal(row.outcome_return_pct, null);

    }
    finally{
        deleteTestUser(userId);
    }

});
