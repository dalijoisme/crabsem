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

const { orderCandidates, runCycle } = require("./tradingBotEngine");
const tradingBotRepository = require("../repositories/tradingBotRepository");
const tradingBotCandidateSightingsRepository = require("../repositories/tradingBotCandidateSightingsRepository");
const tradingBotMissedOpportunityRepository = require("../repositories/tradingBotMissedOpportunityRepository");
const userAuthService = require("./userAuthService");
const db = require("../database/connection");

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

        const cycleTokens = [{ token_address: "TestMissedOppToken111", price: 1, market_cap: 1000000, liquidity: 50000, symbol: "MISS" }];
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
            { token_address: "TestSiblingA111", price: 1, market_cap: 1000000, liquidity: 50000, symbol: "SIBA", price_change_5m: 40 },
            { token_address: "TestSiblingB111", price: 1, market_cap: 1000000, liquidity: 50000, symbol: "SIBB", price_change_5m: 5 }
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

        const cycleTokens = [{ token_address: "TestOpenFailToken111", price: 1, market_cap: 1000000, liquidity: 50000, symbol: "OFAIL" }];
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
            { token_address: "TestRankRejectedA111", price: 1, market_cap: 1000000, liquidity: 50000, symbol: "RRA", price_change_5m: 40 },
            { token_address: "TestRankRejectedB111", price: 1, market_cap: 1000000, liquidity: 50000, symbol: "RRB", price_change_5m: 5 }
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
