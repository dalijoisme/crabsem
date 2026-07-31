// services/entryGateService.test.js - Benchmark Harness Architecture
// section 3/9: proves createEntryGateService(repository) is genuinely
// parameterized - two instances bound to two different (mock)
// repositories never see each other's open-position/cooldown state,
// which is the entire point of the extraction (so the live bot and a
// benchmark participant can share the gate logic without sharing state).
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createEntryGateService, MAX_MARKET_DATA_AGE_SECONDS } = require("./entryGateService");
const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");

function mockRepository({ openPositions = new Set(), lastTrades = new Map() } = {}){
    return {
        findOpenPositionForToken: (addr) => openPositions.has(addr) ? { token_address: addr } : undefined,
        findLastTradeForToken: (addr) => lastTrades.get(addr)
    };
}

// Production Stabilization V2 (Close Remaining BUY Blind Spots, Section
// 8): evaluateEntry now hard-rejects when gmgn_trenches has no real row
// for the candidate at all (MISSING_QUALITY_DATA) - a real, direct DB
// call, same monkey-patch pattern qualityGateService.test.js already
// established for testing this exact dependency in isolation. Every
// test in this file that means to exercise a LATER check gets a clean,
// always-passing fake trenches row by default; the dedicated tests
// below for MISSING_QUALITY_DATA itself override this back to absent.
let originalFindByTokenAddress;
test.beforeEach(() => {
    originalFindByTokenAddress = gmgnTrenchesRepository.findByTokenAddress;
    gmgnTrenchesRepository.findByTokenAddress = () => ({ rug_ratio: 0, top_10_holder_rate: 0.1, raw_json: "{}" });
});
test.afterEach(() => {
    gmgnTrenchesRepository.findByTokenAddress = originalFindByTokenAddress;
});

const config = {
    min_decay_fraction: 0.9, min_confidence: 60, max_open_positions: 5,
    one_position_per_token: 1, cooldown_win_minutes: 5, cooldown_loss_minutes: 30,
    cooldown_reversal_minutes: 15, cooldown_default_minutes: 10
};

function freshBuyLive(){
    return { hasDecision: true, excludeFromTrending: false, action: "BUY", decayFraction: 1, confidence: 80, risk: "MEDIUM" };
}

function nowSqliteTimestamp(){
    return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// Production Hotfix V1.1, Section 1: every token fixture below now
// needs a real, fresh updated_at - the new freshness gate rejects
// anything else outright, before ever reaching the checks each of
// these tests actually means to exercise.
function freshToken(overrides = {}){
    return { token_address: "X", updated_at: nowSqliteTimestamp(), ...overrides };
}

test("evaluateEntry rejects on the standard reasons in the documented order", () => {
    const gate = createEntryGateService(mockRepository());
    const token = freshToken();

    assert.equal(gate.evaluateEntry(token, { hasDecision: false }, config, 0).reason, "NO_ENGINE_DECISION_YET");
    assert.equal(gate.evaluateEntry(token, { hasDecision: true, excludeFromTrending: true, exclusionReason: "STATUS_DEAD" }, config, 0).reason, "HARD_EXCLUDED_STATUS_DEAD");
    assert.equal(gate.evaluateEntry(token, { hasDecision: true, excludeFromTrending: false, action: "HOLD" }, config, 0).reason, "NOT_A_BUY_TIER_HOLD");
    assert.equal(gate.evaluateEntry(token, { hasDecision: true, excludeFromTrending: false, action: "BUY", decayFraction: 0.5 }, config, 0).reason, "DECISION_TOO_STALE");
    assert.equal(gate.evaluateEntry(token, { hasDecision: true, excludeFromTrending: false, action: "BUY", decayFraction: 1, confidence: 10 }, config, 0).reason, "CONFIDENCE_BELOW_FLOOR");
});

// Production Stabilization V2 (Close Remaining BUY Blind Spots, Section
// 8 - Live Safety): a candidate with no real gmgn_trenches row at all
// must be rejected outright, not silently allowed through on missing
// data - a direct query of this account's own real dataset found this
// true for 24.3% of all tracked tokens (3,013 of 12,387), not a rare
// edge case. Checked before quality-gate/rug checks that would
// otherwise no-op on the same absence.
test("evaluateEntry rejects a BUY-tier candidate with no real gmgn_trenches row at all", () => {
    gmgnTrenchesRepository.findByTokenAddress = () => undefined;
    const gate = createEntryGateService(mockRepository());
    const result = gate.evaluateEntry(freshToken(), freshBuyLive(), config, 0);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "MISSING_QUALITY_DATA");
});

test("evaluateEntry accepts a BUY-tier candidate once a real trenches row exists", () => {
    gmgnTrenchesRepository.findByTokenAddress = () => ({ rug_ratio: 0, top_10_holder_rate: 0.1, raw_json: "{}" });
    const gate = createEntryGateService(mockRepository());
    const result = gate.evaluateEntry(freshToken(), freshBuyLive(), config, 0);
    assert.equal(result.eligible, true);
});

test("evaluateEntry rejects when max_open_positions is reached", () => {
    const gate = createEntryGateService(mockRepository());
    const result = gate.evaluateEntry(freshToken(), freshBuyLive(), config, 5);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "MAX_OPEN_POSITIONS_REACHED");
});

test("two gate instances bound to different repositories are fully isolated", () => {

    const repoA = mockRepository({ openPositions: new Set(["TOKEN1"]) });
    const repoB = mockRepository(); // TOKEN1 has no open position here

    const gateA = createEntryGateService(repoA);
    const gateB = createEntryGateService(repoB);

    const token = freshToken({ token_address: "TOKEN1" });

    const resultA = gateA.evaluateEntry(token, freshBuyLive(), config, 0);
    const resultB = gateB.evaluateEntry(token, freshBuyLive(), config, 0);

    assert.equal(resultA.eligible, false);
    assert.equal(resultA.reason, "ALREADY_OPEN_FOR_TOKEN");

    assert.equal(resultB.eligible, true); // repoB has no record of this position at all

});

test("cooldown is evaluated per-repository, not globally", () => {

    const recentLossyClose = { reason: "STOP_LOSS", closed_at: nowSqliteTimestamp() };

    const repoWithCooldown = mockRepository({ lastTrades: new Map([["TOKEN1", recentLossyClose]]) });
    const repoWithoutHistory = mockRepository();

    const gateA = createEntryGateService(repoWithCooldown);
    const gateB = createEntryGateService(repoWithoutHistory);

    const token = freshToken({ token_address: "TOKEN1" });

    assert.equal(gateA.evaluateEntry(token, freshBuyLive(), config, 0).reason, "COOLDOWN_ACTIVE_STOP_LOSS");
    assert.equal(gateB.evaluateEntry(token, freshBuyLive(), config, 0).eligible, true);

});

// Production Hotfix V1.1, Section 1/7: the freshness gate itself -
// rejects outright (never a confidence penalty) on stale/missing
// market data, accepts fresh data, and the exact boundary is inclusive
// at MAX_MARKET_DATA_AGE_SECONDS.
test("evaluateEntry rejects a BUY-tier candidate whose market snapshot is stale", () => {
    const gate = createEntryGateService(mockRepository());
    const staleTimestamp = new Date(Date.now() - (MAX_MARKET_DATA_AGE_SECONDS + 60) * 1000).toISOString().slice(0, 19).replace("T", " ");
    const token = freshToken({ updated_at: staleTimestamp });

    const result = gate.evaluateEntry(token, freshBuyLive(), config, 0);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "STALE_MARKET_DATA");
    assert.ok(result.marketAgeSeconds > MAX_MARKET_DATA_AGE_SECONDS);
});

test("evaluateEntry rejects a BUY-tier candidate with no real timestamp at all - never fresh by default", () => {
    const gate = createEntryGateService(mockRepository());
    const token = freshToken({ updated_at: null, last_seen: null });

    const result = gate.evaluateEntry(token, freshBuyLive(), config, 0);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "STALE_MARKET_DATA");
    assert.equal(result.marketAgeSeconds, null);
});

test("evaluateEntry accepts a BUY-tier candidate right at the freshness boundary, rejects just past it", () => {
    const gate = createEntryGateService(mockRepository());

    const justInsideMs = (MAX_MARKET_DATA_AGE_SECONDS - 1) * 1000;
    const justInside = freshToken({ updated_at: new Date(Date.now() - justInsideMs).toISOString().slice(0, 19).replace("T", " ") });
    assert.notEqual(gate.evaluateEntry(justInside, freshBuyLive(), config, 0).reason, "STALE_MARKET_DATA");

    const justOutsideMs = (MAX_MARKET_DATA_AGE_SECONDS + 5) * 1000;
    const justOutside = freshToken({ updated_at: new Date(Date.now() - justOutsideMs).toISOString().slice(0, 19).replace("T", " ") });
    assert.equal(gate.evaluateEntry(justOutside, freshBuyLive(), config, 0).reason, "STALE_MARKET_DATA");
});

// Production Stabilization V2 (BUY Quality sprint, Section L proposal #1):
// a HIGH-risk candidate is rejected outright, never merely scored lower -
// same "hard reject on an already-computed signal" pattern as the
// freshness gate above, checked before decayFraction/confidence.
test("evaluateEntry rejects a BUY-tier candidate whose engine-computed risk is HIGH", () => {
    const gate = createEntryGateService(mockRepository());
    const live = { ...freshBuyLive(), risk: "HIGH", riskReasons: ["Very few holders (18) - concentration risk", "High holder concentration (top 10 hold 59.3%)"] };

    const result = gate.evaluateEntry(freshToken(), live, config, 0);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "HIGH_RISK_REJECTED");
    assert.equal(result.riskReasons.length, 2);
});

test("evaluateEntry accepts MEDIUM/LOW risk candidates - only HIGH is a hard reject", () => {
    const gate = createEntryGateService(mockRepository());

    assert.equal(gate.evaluateEntry(freshToken({ token_address: "M" }), { ...freshBuyLive(), risk: "MEDIUM" }, config, 0).eligible, true);
    assert.equal(gate.evaluateEntry(freshToken({ token_address: "L" }), { ...freshBuyLive(), risk: "LOW" }, config, 0).eligible, true);
});

// Real replay: this account's own actual, historical BUY. MOON
// (2026-07-30, token_address 415jRB5Y5t9BujcL8BZkKQiK6oBx9Ce29cynp47eMooN)
// was risk:"HIGH" at the moment it was really bought - 18 holders, 59.3%
// top-10 concentration, developer still holding 32% of supply, snipers
// holding 32%, and an already-350%-in-1h price move (5 real riskReasons,
// stored verbatim in trading_bot_positions.risk for this real position).
// This proves the new gate would have blocked the exact real BUY that
// motivated this sprint, not a synthetic stand-in.
test("real replay: MOON's own real HIGH-risk profile at entry is rejected by the new gate", () => {
    const gate = createEntryGateService(mockRepository());
    const moonLive = {
        hasDecision: true, excludeFromTrending: false, action: "STRONG BUY",
        decayFraction: 1, confidence: 49, risk: "HIGH",
        riskReasons: [
            "Developer still holds 32% of supply - dump risk",
            "Snipers hold 32% of top holdings",
            "Very few holders (18) - concentration risk",
            "High holder concentration (top 10 hold 59.3%)",
            "Price has already moved sharply (293% in 1h) - elevated reversal risk"
        ]
    };
    const moonToken = freshToken({ token_address: "415jRB5Y5t9BujcL8BZkKQiK6oBx9Ce29cynp47eMooN" });

    const result = gate.evaluateEntry(moonToken, moonLive, config, 0);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "HIGH_RISK_REJECTED");
});
