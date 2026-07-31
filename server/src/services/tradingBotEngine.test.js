// services/tradingBotEngine.test.js - Final Spec section 18's mandatory
// regression test: with strategy_profile=STABLE (opportunity_priority_enabled=0,
// emi_enabled=0) and execution_mode=REGULAR, candidate ORDER must be
// byte-identical to the bot's pre-Constitution behavior (plain
// gmgnTokenRepository.getAllTokens() order, untouched) - proof this
// milestone did not silently change behavior for the baseline profile.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { orderCandidates, runCycle, msSinceTokenSeen, extractFreshPriceAndLiquidity, refreshStaleHeldToken, HELD_POSITION_STALE_AFTER_MS } = require("./tradingBotEngine");
const tradingBotRepository = require("../repositories/tradingBotRepository");
const tradingBotCandidateSightingsRepository = require("../repositories/tradingBotCandidateSightingsRepository");
const tradingBotMissedOpportunityRepository = require("../repositories/tradingBotMissedOpportunityRepository");
const userAuthService = require("./userAuthService");
const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const researchEngineFactory = require("./researchEngineFactory");
const strategyProfileTranslator = require("./strategyProfileTranslator");
const db = require("../database/connection");

// Production Stabilization V2 (Close Remaining BUY Blind Spots, Section
// 8): entryGateService now hard-rejects a real BUY candidate with no
// gmgn_trenches row at all (MISSING_QUALITY_DATA) - same monkey-patch
// pattern qualityGateService.test.js/entryGateService.test.js already
// use for this exact real-DB dependency. A clean, always-passing fake
// row by default, so every test below still exercises whatever LATER
// check it actually means to - real per-test token addresses (fake
// strings like "TestToken111") would otherwise never have a real row.
let originalFindByTokenAddress;
test.beforeEach(() => {
    originalFindByTokenAddress = gmgnTrenchesRepository.findByTokenAddress;
    gmgnTrenchesRepository.findByTokenAddress = () => ({ rug_ratio: 0, top_10_holder_rate: 0.1, raw_json: "{}" });
});
test.afterEach(() => {
    gmgnTrenchesRepository.findByTokenAddress = originalFindByTokenAddress;
});

// Production Hotfix V1.1, Section 1: every BUY-tier token fixture in
// this file needs a real, fresh updated_at from here on - the new
// freshness gate (entryGateService.js) rejects anything else outright,
// before the check each test actually means to exercise.
function nowSqliteTimestamp(){
    return new Date().toISOString().slice(0, 19).replace("T", " ");
}

const tokens = [
    { token_address: "A" },
    { token_address: "B" },
    { token_address: "C" }
];

const liveByAddress = new Map([
    ["A", { action: "BUY" }],
    ["B", { action: "STRONG BUY" }],
    ["C", { action: "HOLD" }]
]);

test("STABLE profile (opportunity_priority_enabled=0, execution_mode=REGULAR) leaves candidate order untouched", () => {

    const botConfig = { opportunity_priority_enabled: 0, emi_enabled: 0, execution_mode: "REGULAR" };

    const { orderedTokens, rankInfoByAddress } = orderCandidates(tokens, liveByAddress, botConfig);

    assert.deepEqual(orderedTokens, tokens);
    assert.equal(orderedTokens, tokens); // same array instance, not just equal contents - zero transformation ran
    assert.equal(rankInfoByAddress.size, 0); // Opportunity Priority off - honestly no rank, never fabricated

});

test("opportunity_priority_enabled=0 with no execution_mode set also falls through unchanged (default legacy behavior)", () => {

    const botConfig = { opportunity_priority_enabled: 0, emi_enabled: 0, execution_mode: undefined };

    const { orderedTokens } = orderCandidates(tokens, liveByAddress, botConfig);

    assert.equal(orderedTokens, tokens);

});

// Live Decision Center / Signal Center sprint: opportunityPriorityService.rank()
// already computes combinedRank/priorityScore/tier per BUY-tier token every
// cycle - this proves it's no longer discarded (rankInfoByAddress), and that
// it stays keyed only to the real BUY/STRONG BUY subset (HOLD/AVOID tokens
// never get a fabricated rank).
test("opportunity_priority_enabled=1 surfaces a real rankInfoByAddress for BUY-tier tokens only, in real leaderboard order", () => {

    const rankTokens = [
        { token_address: "RANKTEST_SLOW", price_change_5m: 5 },
        { token_address: "RANKTEST_FAST", price_change_5m: 40 },
        { token_address: "RANKTEST_HOLD", price_change_5m: 100 } // HOLD tier - price velocity irrelevant, must never be ranked
    ];

    const rankLiveByAddress = new Map([
        ["RANKTEST_SLOW", { action: "BUY" }],
        ["RANKTEST_FAST", { action: "STRONG BUY" }],
        ["RANKTEST_HOLD", { action: "HOLD" }]
    ]);

    const botConfig = { opportunity_priority_enabled: 1, emi_enabled: 0 };

    const { orderedTokens, rankInfoByAddress } = orderCandidates(rankTokens, rankLiveByAddress, botConfig);

    // Only the two real BUY-tier tokens are ranked - HOLD never appears
    assert.equal(rankInfoByAddress.size, 2);
    assert.ok(!rankInfoByAddress.has("RANKTEST_HOLD"));

    const fastInfo = rankInfoByAddress.get("RANKTEST_FAST");
    const slowInfo = rankInfoByAddress.get("RANKTEST_SLOW");

    // Higher real 5m price velocity ranks better (lower rank index = leaderboard position 0)
    assert.equal(fastInfo.rank, 0);
    assert.equal(slowInfo.rank, 1);
    assert.ok(fastInfo.priorityScore > slowInfo.priorityScore);
    assert.ok(["HEATING", "WARM", "NORMAL"].includes(fastInfo.tier));

    // orderedTokens still leads with the better-ranked token, HOLD trails (never eligible anyway)
    assert.equal(orderedTokens[0].token_address, "RANKTEST_FAST");
    assert.equal(orderedTokens[1].token_address, "RANKTEST_SLOW");

});

// False Positive Reduction V2, Priority 4: a HIGH-risk candidate must
// never occupy a ranked leaderboard slot, even if its own heat factors
// (price velocity, etc.) would otherwise put it at rank #1 - real proof
// this sprint found: MOON, this account's own real BUY, ranked #2 of 2
// at priority 97 while risk:"HIGH", entirely on momentum factors that
// know nothing about risk. A MEDIUM/LOW-risk BUY-tier token is
// unaffected - only HIGH is excluded from ranking, matching
// entryGateService's own HIGH-risk hard reject exactly.
test("opportunity_priority_enabled=1 never ranks a HIGH-risk candidate, even when its momentum factors are the strongest", () => {

    const rankTokens = [
        { token_address: "RANKTEST_HIGHRISK_HOT", price_change_5m: 90 }, // strongest momentum factor by far
        { token_address: "RANKTEST_MEDIUM", price_change_5m: 10 }
    ];

    const rankLiveByAddress = new Map([
        ["RANKTEST_HIGHRISK_HOT", { action: "STRONG BUY", risk: "HIGH" }],
        ["RANKTEST_MEDIUM", { action: "BUY", risk: "MEDIUM" }]
    ]);

    const botConfig = { opportunity_priority_enabled: 1, emi_enabled: 0 };

    const { orderedTokens, rankInfoByAddress } = orderCandidates(rankTokens, rankLiveByAddress, botConfig);

    // Only the MEDIUM-risk token is ranked - the HIGH-risk one, despite
    // having the strongest momentum factor, never gets a rank at all.
    assert.equal(rankInfoByAddress.size, 1);
    assert.ok(!rankInfoByAddress.has("RANKTEST_HIGHRISK_HOT"));
    assert.ok(rankInfoByAddress.has("RANKTEST_MEDIUM"));
    assert.equal(rankInfoByAddress.get("RANKTEST_MEDIUM").rank, 0);

    // Still present in orderedTokens (still real-evaluated/real-logged by
    // the entry gate below) - just trailing, unranked, never leaderboard-topping.
    assert.equal(orderedTokens.length, 2);
    assert.equal(orderedTokens[0].token_address, "RANKTEST_MEDIUM");
    assert.equal(orderedTokens[1].token_address, "RANKTEST_HIGHRISK_HOT");

});

// Trust/UX sprint: runCycle() used to leave Scanner/Filtering/Ranking/
// Monitor entirely invisible to the dashboard - only a server console.log
// existed. Proves a real SYSTEM log row now lands every cycle with the
// real scanned/opened/closed/skipped counts.
test("runCycle writes a real cycle-summary log row every time it actually runs", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        tradingBotRepository.updateState(userId, { status: "RUNNING", mode: "SIMULATION", lastAction: "TEST_START" });

        // STABLE default config: opportunity_priority_enabled=0, so
        // orderCandidates is a pure passthrough - no ranking/worker-pool
        // machinery needed for this test. Neither token clears the BUY
        // tier, so this exercises only the "scan and skip" path, real
        // engine, no network.
        const cycleTokens = [{ token_address: "TestCycleLogToken111", price: 1, market_cap: 1000, symbol: "X" }];
        const cycleLiveByAddress = new Map([
            ["TestCycleLogToken111", { action: "HOLD", confidence: 50, hasDecision: true, decayFraction: 1, risk: "LOW", excludeFromTrending: false }]
        ]);

        const result = await runCycle(userId, cycleTokens, cycleLiveByAddress);
        assert.equal(result.scanned, 1);
        assert.equal(result.skipped, 1);

        const log = tradingBotRepository.findRecentLog(userId, 5);
        const cycleLogRow = log.find(l => l.message.startsWith("Cycle complete:"));
        assert.ok(cycleLogRow, "a real 'Cycle complete: ...' SYSTEM log row must exist after a real cycle ran");
        assert.equal(cycleLogRow.log_type, "SYSTEM");
        assert.equal(cycleLogRow.message, "Cycle complete: scanned 1, opened 0, closed 0, skipped 1.");

    }
    finally{
        // trading_bot_decision_snapshot (Live Decision Center sprint) has a
        // real FK to users(id) - must be deleted before the users row
        // itself, or "DELETE FROM users" below fails with a real FK
        // violation now that runCycle() actually writes a snapshot row.
        db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});

// Live Decision Center sprint: a real HOLD-tier token must land in the
// bounded decision-snapshot table (never the full scan universe), and
// two more real Filtering/Ranking SYSTEM log rows must appear alongside
// the existing cycle-summary row - all derived from data this exact
// cycle already computed, never a new score.
test("runCycle writes a bounded decision-snapshot row and real Filtering/Ranking log rows", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        tradingBotRepository.updateState(userId, { status: "RUNNING", mode: "SIMULATION", lastAction: "TEST_START" });

        const cycleTokens = [{ token_address: "TestSnapshotToken111", price: 1, market_cap: 1000, symbol: "SNAP" }];
        const cycleLiveByAddress = new Map([
            ["TestSnapshotToken111", {
                action: "HOLD", confidence: 42, hasDecision: true, decayFraction: 1, risk: "MEDIUM",
                excludeFromTrending: false, reasons: ["Net accumulation detected"]
            }]
        ]);

        await runCycle(userId, cycleTokens, cycleLiveByAddress);

        const snapshot = tradingBotRepository.findDecisionSnapshot(userId);
        assert.equal(snapshot.length, 1);
        assert.equal(snapshot[0].token_address, "TestSnapshotToken111");
        assert.equal(snapshot[0].action, "HOLD");
        assert.equal(snapshot[0].confidence, 42);
        assert.equal(snapshot[0].rank, null); // Opportunity Priority never ranks HOLD-tier tokens - honestly absent

        const log = tradingBotRepository.findRecentLog(userId, 10);
        const filteringLog = log.find(l => l.message.startsWith("Filtering:"));
        assert.ok(filteringLog, "a real Filtering SYSTEM row must exist");
        assert.equal(filteringLog.message, "Filtering: 0 qualified (BUY/STRONG BUY) of 1 scanned.");

        const rankingLog = log.find(l => l.message.startsWith("Ranking:"));
        assert.ok(rankingLog, "a real Ranking SYSTEM row must exist");
        assert.equal(rankingLog.message, "Ranking: no ranked BUY-tier candidate this cycle.");

        // A SECOND cycle must REPLACE, never accumulate, the snapshot -
        // still bounded by candidate count, not by cycle count.
        await runCycle(userId, cycleTokens, cycleLiveByAddress);
        assert.equal(tradingBotRepository.findDecisionSnapshot(userId).length, 1);

    }
    finally{
        db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});

// Momentum Validation System sprint (this sprint's own stated top
// priority): a real BUY-tier token genuinely rejected by the frozen
// entry gate (confidence below floor - never touched, never guessed)
// must land a pending missed-opportunity row with the real rank/reason,
// and a REPEATED rejection must refresh that same row, never duplicate
// it - the bounding contract migration 053's partial unique index
// enforces.
test("runCycle upserts a pending missed-opportunity row for a real BUY-tier rejection, refreshing rather than duplicating on repeat", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        tradingBotRepository.updateState(userId, { status: "RUNNING", mode: "SIMULATION", lastAction: "TEST_START" });
        tradingBotRepository.updateConfig(userId, { opportunity_priority_enabled: 1, emi_enabled: 0 });

        const cycleTokens = [{ token_address: "TestMissedOppToken111", price: 1, market_cap: 1000000, liquidity: 50000, symbol: "MISS", updated_at: nowSqliteTimestamp() }];
        // confidence 30 is below the real, unchanged min_confidence floor
        // (default 60) - a genuine BUY-tier rejection, not a fabricated one.
        const cycleLiveByAddress = new Map([
            ["TestMissedOppToken111", { action: "BUY", confidence: 30, hasDecision: true, decayFraction: 1, risk: "LOW", excludeFromTrending: false }]
        ]);

        await runCycle(userId, cycleTokens, cycleLiveByAddress);

        let rows = db.prepare("SELECT * FROM trading_bot_missed_opportunity WHERE user_id = ?").all(userId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].token_address, "TestMissedOppToken111");
        assert.equal(rows[0].reason, "CONFIDENCE_BELOW_FLOOR");
        assert.equal(rows[0].price_at_skip, 1);
        assert.equal(rows[0].outcome_evaluated_at, null);
        const firstSkippedAt = rows[0].skipped_at;

        // Second cycle, same real rejection - must refresh, never duplicate
        await runCycle(userId, cycleTokens, cycleLiveByAddress);
        rows = db.prepare("SELECT * FROM trading_bot_missed_opportunity WHERE user_id = ?").all(userId);
        assert.equal(rows.length, 1, "a repeated rejection must refresh the same pending row, never insert a duplicate");
        assert.equal(rows[0].skipped_at, firstSkippedAt, "skipped_at (first-missed) must not reset on a refresh");

    }
    finally{
        db.prepare("DELETE FROM trading_bot_missed_opportunity WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_candidate_sightings WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});

// Self-Comparison + candidate-sightings: two real BUY-tier candidates,
// both actually bought this cycle (enough cash/slots for both, real
// default config) - each real BUY must record a real candidate-sighting
// row, and each position's siblings_json must list the OTHER real
// ranked candidate from the same cycle, never itself, never a fabricated
// entry.
test("runCycle records real candidate sightings and attaches real cycle siblings onto each BUY", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        tradingBotRepository.updateState(userId, { status: "RUNNING", mode: "SIMULATION", lastAction: "TEST_START" });
        tradingBotRepository.updateConfig(userId, { opportunity_priority_enabled: 1, emi_enabled: 0 });

        const cycleTokens = [
            { token_address: "TestSiblingA111", price: 1, market_cap: 1000000, liquidity: 50000, symbol: "SIBA", price_change_5m: 40, updated_at: nowSqliteTimestamp() },
            { token_address: "TestSiblingB111", price: 1, market_cap: 1000000, liquidity: 50000, symbol: "SIBB", price_change_5m: 5, updated_at: nowSqliteTimestamp() }
        ];
        const cycleLiveByAddress = new Map([
            ["TestSiblingA111", { action: "STRONG BUY", confidence: 90, hasDecision: true, decayFraction: 1, risk: "LOW", excludeFromTrending: false }],
            ["TestSiblingB111", { action: "BUY", confidence: 90, hasDecision: true, decayFraction: 1, risk: "LOW", excludeFromTrending: false }]
        ]);

        const result = await runCycle(userId, cycleTokens, cycleLiveByAddress);
        assert.equal(result.opened, 2, `both real BUY-tier candidates should open (got: ${JSON.stringify(result)})`);

        const sightingA = tradingBotCandidateSightingsRepository.findByUserAndToken(userId, "TestSiblingA111");
        const sightingB = tradingBotCandidateSightingsRepository.findByUserAndToken(userId, "TestSiblingB111");
        assert.ok(sightingA, "a real candidate-sighting row must exist for A");
        assert.ok(sightingB, "a real candidate-sighting row must exist for B");
        assert.equal(sightingA.entry_price_at_first_sight, 1);

        const positions = db.prepare("SELECT * FROM trading_bot_positions WHERE user_id = ? ORDER BY token_address ASC").all(userId);
        assert.equal(positions.length, 2);

        const posA = positions.find(p => p.token_address === "TestSiblingA111");
        const posB = positions.find(p => p.token_address === "TestSiblingB111");
        assert.ok(posA.siblings_json, "position A must have real siblings recorded");
        assert.ok(posB.siblings_json, "position B must have real siblings recorded");

        const siblingsOfA = JSON.parse(posA.siblings_json);
        assert.equal(siblingsOfA.length, 1);
        assert.equal(siblingsOfA[0].tokenAddress, "TestSiblingB111"); // never itself
        const siblingsOfB = JSON.parse(posB.siblings_json);
        assert.equal(siblingsOfB[0].tokenAddress, "TestSiblingA111");

    }
    finally{
        db.prepare("DELETE FROM trading_bot_missed_opportunity WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_candidate_sightings WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});

// Phase 2 (Live Validation & Bottleneck Elimination): openPosition's own
// real post-eligibility failure (INSUFFICIENT_AVAILABLE_CASH - a real
// BUY-tier candidate whose computed position size fell below the min
// order size) must now land a real missed-opportunity row too - this
// gap previously only captured entryGateService's own rejections.
test("runCycle records a missed-opportunity row for a real openPosition-stage failure (INSUFFICIENT_AVAILABLE_CASH)", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        tradingBotRepository.updateState(userId, { status: "RUNNING", mode: "SIMULATION", lastAction: "TEST_START" });
        // position_size_pct=1 with the real default $100 initial_capital
        // computes a real sizeUsd of $1 - below the real default
        // min_order_size ($10) - a genuine INSUFFICIENT_AVAILABLE_CASH
        // from openPosition itself, not the loop's own cash-exhaustion
        // pre-check (availableCash is still well above min_order_size).
        tradingBotRepository.updateConfig(userId, { opportunity_priority_enabled: 1, emi_enabled: 0, position_size_pct: 1 });

        const cycleTokens = [{ token_address: "TestOpenFailToken111", price: 1, market_cap: 1000000, liquidity: 50000, symbol: "OFAIL", updated_at: nowSqliteTimestamp() }];
        const cycleLiveByAddress = new Map([
            ["TestOpenFailToken111", { action: "BUY", confidence: 90, hasDecision: true, decayFraction: 1, risk: "LOW", excludeFromTrending: false }]
        ]);

        const result = await runCycle(userId, cycleTokens, cycleLiveByAddress);
        assert.equal(result.opened, 0);

        const rows = db.prepare("SELECT * FROM trading_bot_missed_opportunity WHERE user_id = ?").all(userId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].reason, "INSUFFICIENT_AVAILABLE_CASH");
        assert.equal(rows[0].token_address, "TestOpenFailToken111");

    }
    finally{
        db.prepare("DELETE FROM trading_bot_missed_opportunity WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_candidate_sightings WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});

// Phase 2: the real, data-backed "Ranking Rejected" case - a real ranked
// BUY-tier candidate that never even got a turn because a higher-ranked
// one already consumed the last open slot this cycle.
test("runCycle records SLOT_FULL_BEFORE_TURN for a real ranked candidate the buy loop never reached", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        tradingBotRepository.updateState(userId, { status: "RUNNING", mode: "SIMULATION", lastAction: "TEST_START" });
        tradingBotRepository.updateConfig(userId, { opportunity_priority_enabled: 1, emi_enabled: 0, max_open_positions: 1 });

        const cycleTokens = [
            { token_address: "TestRankRejectedA111", price: 1, market_cap: 1000000, liquidity: 50000, symbol: "RRA", price_change_5m: 40, updated_at: nowSqliteTimestamp() },
            { token_address: "TestRankRejectedB111", price: 1, market_cap: 1000000, liquidity: 50000, symbol: "RRB", price_change_5m: 5, updated_at: nowSqliteTimestamp() }
        ];
        const cycleLiveByAddress = new Map([
            ["TestRankRejectedA111", { action: "STRONG BUY", confidence: 90, hasDecision: true, decayFraction: 1, risk: "LOW", excludeFromTrending: false }],
            ["TestRankRejectedB111", { action: "BUY", confidence: 90, hasDecision: true, decayFraction: 1, risk: "LOW", excludeFromTrending: false }]
        ]);

        const result = await runCycle(userId, cycleTokens, cycleLiveByAddress);
        assert.equal(result.opened, 1, "only the higher-ranked candidate (max_open_positions=1) should open");

        const rows = db.prepare("SELECT * FROM trading_bot_missed_opportunity WHERE user_id = ?").all(userId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].token_address, "TestRankRejectedB111", "the lower-ranked, never-reached candidate must be the one recorded");
        assert.equal(rows[0].reason, "SLOT_FULL_BEFORE_TURN");
        assert.equal(rows[0].rank_at_skip, 1); // real leaderboard position, not a fabricated one

    }
    finally{
        db.prepare("DELETE FROM trading_bot_missed_opportunity WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_candidate_sightings WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});

// Production Stabilization V1, Section A (Exit Engine root cause):
// msSinceTokenSeen is the pure staleness gate - a token with no
// last_seen/updated_at at all (never once collected) must be treated as
// infinitely stale, never as "fresh by default".
test("msSinceTokenSeen treats a fresh timestamp as fresh, an old one as stale, and a missing token as infinitely stale", () => {

    const now = new Date();
    const fresh = { last_seen: now.toISOString().slice(0, 19).replace("T", " ") };
    const old = { last_seen: new Date(now.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ") };

    assert.ok(msSinceTokenSeen(fresh) < HELD_POSITION_STALE_AFTER_MS);
    assert.ok(msSinceTokenSeen(old) > HELD_POSITION_STALE_AFTER_MS);
    assert.equal(msSinceTokenSeen(undefined), Infinity);
    assert.equal(msSinceTokenSeen({}), Infinity);

});

// extractFreshPriceAndLiquidity is tested against the ACTUAL real shape
// GMGN's token_pool_info/token_kline endpoints returned in this
// project's own on-demand cache (gmgn_ondemand_cache), not an invented
// shape - see this sprint's own root-cause investigation.
test("extractFreshPriceAndLiquidity reads the real close price and liquidity from real GMGN response shapes", () => {

    const poolResult = {
        data: {
            address: "GrKJPe5MeSVkQ9wLuLBCbpBeFQqdWxh7TqzEPTpepump",
            liquidity: "5122.280806016"
        }
    };
    const klineResult = {
        data: {
            list: [
                { time: 1, open: "0.0000020914576", close: "0.00033867094", high: "0.00039892675", low: "0.0000020914576" },
                { time: 2, open: "0.00033867094", close: "0.0012897003", high: "0.0013795895", low: "0.0010167587" }
            ]
        }
    };

    const fresh = extractFreshPriceAndLiquidity(poolResult, klineResult);
    assert.equal(fresh.price, 0.0012897003, "must use the LAST candle's close, not the first");
    assert.equal(fresh.liquidity, 5122.280806016);

});

test("extractFreshPriceAndLiquidity returns null (never a fabricated price) when GMGN gives no real candle", () => {

    assert.equal(extractFreshPriceAndLiquidity({ data: { liquidity: "100" } }, { data: { list: [] } }), null);
    assert.equal(extractFreshPriceAndLiquidity({ data: {} }, { data: { list: [{ close: "0" }] } }), null);
    assert.equal(extractFreshPriceAndLiquidity(null, null), null);

});

// refreshStaleHeldToken's fail-soft contract: a real GMGN error (or any
// thrown error - no real GMGN call is made in this test, an injected
// fake stands in, same DI seam services/tradeManager.js's liveOptions
// already uses) must never throw out of this function, must log a real
// WARNING, and must return the ORIGINAL token unchanged - a temporarily
// unreachable GMGN is never worse than the stale-data problem it's
// trying to fix.
test("refreshStaleHeldToken fails soft: a GMGN error logs a WARNING and returns the original token unchanged", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const staleToken = { token_address: "TestStaleToken111", symbol: "STALE", price: 0.5, last_seen: "2020-01-01 00:00:00" };
        const position = { token_address: "TestStaleToken111", token_symbol: "STALE", id: 999 };

        const failingOndemand = {
            async getTokenPoolInfo(){ throw new Error("GMGN unreachable (simulated)"); },
            async getTokenKline(){ throw new Error("GMGN unreachable (simulated)"); }
        };

        const result = await refreshStaleHeldToken(userId, position, staleToken, failingOndemand);
        assert.deepEqual(result, staleToken, "on failure, the original token must be returned byte-identical, never a partial/guessed patch");

        const log = tradingBotRepository.findRecentLog(userId, 5);
        const warningLog = log.find(l => l.log_type === "WARNING");
        assert.ok(warningLog, "a real WARNING log row must exist after a failed refresh");
        assert.ok(warningLog.message.includes("STALE"));

    }
    finally{
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});

test("refreshStaleHeldToken applies a real fresh price/liquidity from a successful GMGN response", async () => {

    const staleToken = { token_address: "TestStaleToken222", symbol: "STALE2", price: 0.5, liquidity: 100, market_cap: 9999, last_seen: "2020-01-01 00:00:00" };
    const position = { token_address: "TestStaleToken222", token_symbol: "STALE2", id: 998 };

    const workingOndemand = {
        async getTokenPoolInfo(){ return { data: { liquidity: "777.5" } }; },
        async getTokenKline(){ return { data: { list: [{ close: "1.25" }] } }; }
    };

    const result = await refreshStaleHeldToken(1, position, staleToken, workingOndemand);
    assert.equal(result.price, 1.25, "price must be the fresh, real GMGN value, not the stale one");
    assert.equal(result.liquidity, 777.5, "liquidity must be the fresh, real GMGN value, not the stale one");
    assert.equal(result.market_cap, 9999, "fields outside this fix's scope (market_cap) are left exactly as they were");
    // Production Stabilization Final, Section B: flagged so
    // dynamicExitService knows price/liquidity were re-verified but
    // price_change_5m/volume_1h/trenches were not - never silently
    // trusted as fresh momentum evidence.
    assert.equal(result.marketContextStale, true);

});

// End-to-end wiring proof: a real OPEN position whose token never
// appears in this cycle's shared trending snapshot at all (the actual,
// confirmed shape of the live bug - see this sprint's root-cause
// report) must still get evaluated with a real, fresh price via the
// injected on-demand fallback, and never left stuck at its stale
// current_price/entry_price with mfe_pct/mae_pct frozen at 0.
test("runCycle refreshes a held position's price on-demand when its token has fallen out of the trending snapshot entirely", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        tradingBotRepository.updateState(userId, { status: "RUNNING", mode: "SIMULATION", lastAction: "TEST_START" });

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestGoneFromTrendingToken111", tokenSymbol: "GONE",
            entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 999, targetMarketCap: null, stopLossPrice: 0.5, stopLossMarketCap: null
        });

        // Empty tokens/liveByAddress this cycle - GONE is nowhere in the
        // shared trending snapshot, reproducing the exact real-world
        // shape confirmed in this sprint's root-cause investigation.
        const fakeOndemand = {
            async getTokenPoolInfo(){ return { data: { liquidity: "8000" } }; },
            async getTokenKline(){ return { data: { list: [{ close: "1.10" }] } }; } // +10% real move
        };

        await runCycle(userId, [], new Map(), fakeOndemand);

        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(position.current_price, 1.10, "current_price must reflect the real on-demand price, never stay stuck at entry_price");
        assert.ok(position.mfe_pct > 0, "mfe_pct must move off its 0 default now that a real price was seen");

    }
    finally{
        db.prepare("DELETE FROM trading_bot_trades WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_missed_opportunity WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_candidate_sightings WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});

// Cost/behavior guard: a FRESH token (well inside the staleness window)
// must never trigger the on-demand fallback at all - the injected
// ondemandService here throws immediately if either method is called,
// proving the shared trending snapshot's own price is used untouched
// whenever it's actually still real-time.
test("runCycle does NOT call the on-demand fallback for a position whose token is still fresh", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        tradingBotRepository.updateState(userId, { status: "RUNNING", mode: "SIMULATION", lastAction: "TEST_START" });

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestFreshTrendingToken111", tokenSymbol: "FRESH",
            entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 999, targetMarketCap: null, stopLossPrice: 0.5, stopLossMarketCap: null
        });

        const nowStamp = new Date().toISOString().slice(0, 19).replace("T", " ");
        const cycleTokens = [{
            token_address: "TestFreshTrendingToken111", symbol: "FRESH", price: 1.05,
            market_cap: 1000, last_seen: nowStamp, updated_at: nowStamp
        }];
        // Real scheduler contract: every token in `tokens` always has a
        // matching liveByAddress entry (scheduler/tradingBotScheduler.js's
        // computeLiveByAddressForPhilosophy sets one for every token it's
        // given) - AVOID here so the "look for new entries" half of this
        // same cycle never tries to buy it; this test is only about the
        // OPEN position's own exit-check price source.
        const cycleLiveByAddress = new Map([
            ["TestFreshTrendingToken111", { action: "AVOID", confidence: 0, hasDecision: false, decayFraction: 0, risk: "HIGH", excludeFromTrending: true }]
        ]);

        const mustNeverBeCalled = {
            async getTokenPoolInfo(){ throw new Error("must never be called - token is still fresh"); },
            async getTokenKline(){ throw new Error("must never be called - token is still fresh"); }
        };

        await runCycle(userId, cycleTokens, cycleLiveByAddress, mustNeverBeCalled);

        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(position.current_price, 1.05); // the shared snapshot's own real price, used untouched

    }
    finally{
        db.prepare("DELETE FROM trading_bot_trades WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_missed_opportunity WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_candidate_sightings WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});

// Production Stabilization V1: real end-to-end proof that a genuinely
// fresh BUY today persists a complete decision snapshot: breakdown_json
// (scores/reasons/module breakdown) AND config_snapshot_json (the exact
// trading_bot_config active at decision time - the one previously-
// missing piece; confidence/risk/engine_version were already their own
// columns). This was investigated after 5 real historical positions were
// found with null breakdown_json - this test proves TODAY's wiring is
// not the cause, so no historical row is reconstructed.
//
// Uses the REAL engine (researchEngineFactory.analyzeTokensWithOverride),
// called DIRECTLY - the same real scoring tradeManager.test.js's own
// "openPosition persists the real decision breakdown" test already
// proves safe - deliberately NOT services/scoringWorkerPool.js's worker-
// thread path. An earlier version of this test called scoreTokens()
// against 40 real tokens and hung for 45+ minutes at near-zero CPU (pure
// I/O wait): some participant sub-modules make real on-demand GMGN
// network calls for tokens with no cached data, and scoreTokens() has no
// timeout of its own on the returned Promise - if the worker thread
// stalls on a slow/rate-limited real fetch, the caller waits forever.
// That is a real, separate production risk (see this test's own note
// below) but not something to fix by making an automated test depend on
// live network calls - one real, already-cached token is enough to prove
// the persistence wiring.
test("a real, fresh BUY persists both breakdown_json and config_snapshot_json", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        tradingBotRepository.updateState(userId, { status: "RUNNING", mode: "SIMULATION", lastAction: "TEST_START" });
        tradingBotRepository.updateConfig(userId, { min_confidence: 1, min_decay_fraction: 0, max_open_positions: 20 });

        // ONE real, already-cached token - same one tradeManager.test.js's
        // own real-breakdown test already uses safely (no worker thread,
        // no fresh on-demand network call).
        const token = gmgnTokenRepository.getAllTokens().find(t => t.market_cap > 0 && t.price > 0);
        assert.ok(token, "local dev DB must have at least one real priced token for this test to mean anything");

        const config = tradingBotRepository.getConfig(userId);
        const philosophy = strategyProfileTranslator.translate(config).philosophy;
        const ctx = researchEngineFactory.preloadContext([token]);
        const [signal] = researchEngineFactory.analyzeTokensWithOverride([token], ctx, "momentumHunter", philosophy);

        // action is forced to STRONG BUY - this test is about whether a
        // REAL signal's breakdown/confidence/risk/reasons persist once a
        // BUY happens, not about whether THIS specific real token's own
        // participant score happens to clear the buy tier today (that's
        // real, live-data-dependent, and would make this test flaky).
        // risk is likewise forced away from HIGH: Production Stabilization
        // V2's HIGH-risk gate (entryGateService.js) is a hard, deliberate
        // reject - if today's real dev-DB token happens to compute as
        // HIGH risk, that gate is working exactly as intended and this
        // persistence-only test must not fight it. Every other field is
        // the real, unmodified signal.
        const liveByAddress = new Map([[token.token_address, {
            action: "STRONG BUY", confidence: signal.confidence, risk: signal.risk === "HIGH" ? "MEDIUM" : signal.risk,
            excludeFromTrending: false, hasDecision: true, decayFraction: 1,
            reasons: signal.reasons, breakdown: signal.breakdown,
            riskReasons: signal.riskReasons, freshnessPenalty: signal.freshnessPenalty,
            participantScore: signal.participantScore, marketHealth: signal.marketHealth,
            participantMax: signal.participantMax, marketHealthMax: signal.marketHealthMax,
            acceleration: signal.acceleration
        }]]);

        // Production Hotfix V1.1, Section 1: the real dev-DB token above
        // is whatever age it happens to be (irrelevant to what this test
        // actually proves - real breakdown/config_snapshot persistence)
        // - only the freshness TIMESTAMP is overridden here, on a clone,
        // so the new gate doesn't reject it. The REAL signal above was
        // still computed from the genuinely real, unmodified token.
        const freshToken = { ...token, updated_at: nowSqliteTimestamp() };
        const result = await runCycle(userId, [freshToken], liveByAddress);

        const positions = db.prepare("SELECT breakdown_json, config_snapshot_json, confidence, risk, engine_version FROM trading_bot_positions WHERE user_id = ?").all(userId);
        assert.ok(positions.length > 0, `this BUY must occur for this test to prove anything (opened=${result.opened}, scanned=${result.scanned}, skipReasons=${JSON.stringify(result.skipReasons)})`);

        for(const position of positions){
            assert.ok(position.breakdown_json, "every real BUY must persist a real breakdown_json");
            assert.ok(position.config_snapshot_json, "every real BUY must persist a real config_snapshot_json");
            assert.ok(position.confidence != null, "confidence must be a real, already-stored column");
            assert.ok(position.engine_version, "engine_version must be a real, already-stored column");

            const configSnapshot = JSON.parse(position.config_snapshot_json);
            assert.equal(configSnapshot.min_confidence, 1, "the snapshot must reflect the REAL config active at decision time, not a default");
            assert.equal(configSnapshot.user_id, userId);

            // Production Stabilization Final, Section G/H: the entry
            // gate's own real result must survive the full runCycle path
            // end to end - not just when hand-constructed in a unit test.
            const breakdown = JSON.parse(position.breakdown_json);
            assert.ok(breakdown.entryGateResult, "entryGateResult must be persisted for every real BUY that goes through runCycle");
            assert.equal(breakdown.entryGateResult.eligible, true);
            assert.equal(breakdown.entryGateResult.decayFraction, 1);
            assert.ok(breakdown.entryGateResult.marketAgeSeconds < 120, "the real, verified freshness age must be captured, not just assumed");
        }

    }
    finally{
        db.prepare("DELETE FROM trading_bot_trades WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_missed_opportunity WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_candidate_sightings WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});

// Section H (Candidate Card): a real BUY-tier candidate's decision-
// snapshot row must carry a real, non-null targetPrice (buildRiskBands'
// own real projection, the exact same function tradeManager.js's
// openPosition() calls at real BUY time) - an AVOID-tier row must never
// get one (nothing to project for a token being avoided).
test("runCycle attaches a real targetPrice to BUY-tier decision-snapshot rows, never to AVOID-tier rows", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        tradingBotRepository.updateState(userId, { status: "RUNNING", mode: "SIMULATION", lastAction: "TEST_START" });

        const cycleTokens = [
            { token_address: "TestTargetBuyToken111", price: 1, market_cap: 1000000, symbol: "TARGBUY", price_change_1h: 5 },
            { token_address: "TestTargetAvoidToken111", price: 1, market_cap: 1000000, symbol: "TARGAVOID", price_change_1h: 5 }
        ];
        const cycleLiveByAddress = new Map([
            ["TestTargetBuyToken111", { action: "STRONG BUY", confidence: 90, hasDecision: true, decayFraction: 1, risk: "LOW", excludeFromTrending: false, participantScore: 85 }],
            ["TestTargetAvoidToken111", { action: "AVOID", confidence: 10, hasDecision: true, decayFraction: 1, risk: "HIGH", excludeFromTrending: false, participantScore: 10 }]
        ]);

        await runCycle(userId, cycleTokens, cycleLiveByAddress);

        const snapshot = db.prepare("SELECT token_address, action, target_price FROM trading_bot_decision_snapshot WHERE user_id = ?").all(userId);
        const buyRow = snapshot.find(r => r.token_address === "TestTargetBuyToken111");
        const avoidRow = snapshot.find(r => r.token_address === "TestTargetAvoidToken111");

        assert.ok(buyRow, "the BUY-tier candidate must be in the snapshot");
        assert.ok(buyRow.target_price > 0, "a real target price must be computed for a BUY-tier candidate with a real market_cap");

        assert.ok(avoidRow, "the AVOID-tier candidate must still be in the snapshot (as an avoid sample)");
        assert.equal(avoidRow.target_price, null, "AVOID-tier rows must never get a target price");

    }
    finally{
        db.prepare("DELETE FROM trading_bot_missed_opportunity WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_candidate_sightings WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});

// Production Hotfix V1.1, Section 3: every decision-snapshot row must
// carry real freshness observability - marketAgeSeconds/lastSnapshotAt/
// decisionTime/snapshotSource - not just silently factor into the gate.
test("runCycle attaches real freshness observability to every decision-snapshot row", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        tradingBotRepository.updateState(userId, { status: "RUNNING", mode: "SIMULATION", lastAction: "TEST_START" });

        const freshTimestamp = nowSqliteTimestamp();
        const staleTimestamp = new Date(Date.now() - 10000 * 1000).toISOString().slice(0, 19).replace("T", " ");

        const cycleTokens = [
            { token_address: "TestFreshObsToken111", price: 1, market_cap: 1000, symbol: "FRESHOBS", updated_at: freshTimestamp },
            { token_address: "TestStaleObsToken111", price: 1, market_cap: 1000, symbol: "STALEOBS", updated_at: staleTimestamp }
        ];
        const cycleLiveByAddress = new Map([
            ["TestFreshObsToken111", { action: "HOLD", confidence: 50, hasDecision: true, decayFraction: 1, risk: "LOW", excludeFromTrending: false }],
            ["TestStaleObsToken111", { action: "HOLD", confidence: 50, hasDecision: true, decayFraction: 1, risk: "LOW", excludeFromTrending: false }]
        ]);

        await runCycle(userId, cycleTokens, cycleLiveByAddress);

        const snapshot = db.prepare("SELECT token_address, market_age_seconds, last_snapshot_at, decision_time, snapshot_source FROM trading_bot_decision_snapshot WHERE user_id = ?").all(userId);
        const freshRow = snapshot.find(r => r.token_address === "TestFreshObsToken111");
        const staleRow = snapshot.find(r => r.token_address === "TestStaleObsToken111");

        assert.ok(freshRow);
        assert.ok(freshRow.market_age_seconds < 10, "a genuinely fresh token must show a small real age");
        assert.equal(freshRow.last_snapshot_at, freshTimestamp);
        assert.ok(freshRow.decision_time, "decision_time must be real, not null");
        assert.equal(freshRow.snapshot_source, "GMGN_TRENDING");

        assert.ok(staleRow);
        assert.ok(staleRow.market_age_seconds > 9000, "a genuinely stale token must show its real, large age - never hidden");
        assert.equal(staleRow.last_snapshot_at, staleTimestamp);

    }
    finally{
        db.prepare("DELETE FROM trading_bot_missed_opportunity WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_candidate_sightings WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});

// Production Stabilization V2 (BUY Quality sprint): real replay of this
// account's own actual, historical BUY. MOON (opened 2026-07-30, token
// 415jRB5Y5t9BujcL8BZkKQiK6oBx9Ce29cynp47eMooN) was really bought with
// risk:"HIGH" already computed and stored (trading_bot_positions.risk) -
// 18 holders, 59.3% top-10 concentration, developer holding 32% of
// supply, snipers holding 32%, an already-350%-in-1h move - 5 real
// riskReasons, verified against this exact real row. Nothing gated on
// that classification before this sprint. This test proves the new gate
// would have blocked the actual real incident, not a synthetic stand-in,
// and that the rejection is never silent.
test("real replay: runCycle rejects MOON's own real HIGH-risk profile and logs why, never silently", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        tradingBotRepository.updateState(userId, { status: "RUNNING", mode: "SIMULATION", lastAction: "TEST_START" });

        const moonAddress = "415jRB5Y5t9BujcL8BZkKQiK6oBx9Ce29cynp47eMooN";
        const moonRiskReasons = [
            "Developer still holds 32% of supply - dump risk",
            "Snipers hold 32% of top holdings",
            "Very few holders (18) - concentration risk",
            "High holder concentration (top 10 hold 59.3%)",
            "Price has already moved sharply (293% in 1h) - elevated reversal risk"
        ];
        const cycleTokens = [{ token_address: moonAddress, price: 0.000011505, market_cap: 11505, liquidity: 10474.6, holders: 18, symbol: "MOON", updated_at: nowSqliteTimestamp() }];
        const cycleLiveByAddress = new Map([
            [moonAddress, { action: "STRONG BUY", confidence: 49, hasDecision: true, decayFraction: 1, risk: "HIGH", riskReasons: moonRiskReasons, excludeFromTrending: false }]
        ]);

        const result = await runCycle(userId, cycleTokens, cycleLiveByAddress);
        assert.equal(result.opened, 0, "MOON's real HIGH-risk profile must never actually be bought under the new gate");
        assert.equal(result.skipReasons.HIGH_RISK_REJECTED, 1);

        const log = tradingBotRepository.findRecentLog(userId, 10);
        const warningLog = log.find(l => l.log_type === "WARNING" && l.message.startsWith("Rejected: HIGH risk"));
        assert.ok(warningLog, "a real, human-readable WARNING log row must exist - never a silent rejection");
        assert.ok(warningLog.message.includes("5 red flags"));

    }
    finally{
        db.prepare("DELETE FROM trading_bot_missed_opportunity WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_candidate_sightings WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});

// Production Hotfix V1.1, Section 1/3: a real BUY-tier candidate
// rejected for staleness must produce a real, human-readable WARNING
// log row - never a silent rejection.
test("runCycle logs a clear, human-readable WARNING when a candidate is rejected for stale market data", async () => {

    const testEmail = `tradingbotengine.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        tradingBotRepository.updateState(userId, { status: "RUNNING", mode: "SIMULATION", lastAction: "TEST_START" });

        const staleTimestamp = new Date(Date.now() - 438 * 1000).toISOString().slice(0, 19).replace("T", " ");
        const cycleTokens = [{ token_address: "TestStaleRejectToken111", price: 1, market_cap: 1000000, symbol: "STALEREJ", updated_at: staleTimestamp }];
        const cycleLiveByAddress = new Map([
            ["TestStaleRejectToken111", { action: "STRONG BUY", confidence: 90, hasDecision: true, decayFraction: 1, risk: "LOW", excludeFromTrending: false }]
        ]);

        const result = await runCycle(userId, cycleTokens, cycleLiveByAddress);
        assert.equal(result.opened, 0, "a stale candidate must never actually be bought");
        assert.equal(result.skipReasons.STALE_MARKET_DATA, 1);

        const log = tradingBotRepository.findRecentLog(userId, 10);
        const warningLog = log.find(l => l.log_type === "WARNING" && l.message.startsWith("Rejected: Market data stale"));
        assert.ok(warningLog, "a real, human-readable WARNING log row must exist - never a silent rejection");
        assert.ok(warningLog.message.includes("438 seconds old") || /\d+ seconds old/.test(warningLog.message));

    }
    finally{
        db.prepare("DELETE FROM trading_bot_missed_opportunity WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_candidate_sightings WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_equity_snapshot WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }

});
