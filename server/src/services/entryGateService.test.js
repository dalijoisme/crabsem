// services/entryGateService.test.js - Benchmark Harness Architecture
// section 3/9: proves createEntryGateService(repository) is genuinely
// parameterized - two instances bound to two different (mock)
// repositories never see each other's open-position/cooldown state,
// which is the entire point of the extraction (so the live bot and a
// benchmark participant can share the gate logic without sharing state).
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createEntryGateService } = require("./entryGateService");

function mockRepository({ openPositions = new Set(), lastTrades = new Map() } = {}){
    return {
        findOpenPositionForToken: (addr) => openPositions.has(addr) ? { token_address: addr } : undefined,
        findLastTradeForToken: (addr) => lastTrades.get(addr)
    };
}

const config = {
    min_decay_fraction: 0.9, min_confidence: 60, max_open_positions: 5,
    one_position_per_token: 1, cooldown_win_minutes: 5, cooldown_loss_minutes: 30,
    cooldown_reversal_minutes: 15, cooldown_default_minutes: 10
};

function freshBuyLive(){
    return { hasDecision: true, excludeFromTrending: false, action: "BUY", decayFraction: 1, confidence: 80, risk: "MEDIUM" };
}

test("evaluateEntry rejects on the standard reasons in the documented order", () => {
    const gate = createEntryGateService(mockRepository());
    const token = { token_address: "X" };

    assert.equal(gate.evaluateEntry(token, { hasDecision: false }, config, 0).reason, "NO_ENGINE_DECISION_YET");
    assert.equal(gate.evaluateEntry(token, { hasDecision: true, excludeFromTrending: true, exclusionReason: "STATUS_DEAD" }, config, 0).reason, "HARD_EXCLUDED_STATUS_DEAD");
    assert.equal(gate.evaluateEntry(token, { hasDecision: true, excludeFromTrending: false, action: "HOLD" }, config, 0).reason, "NOT_A_BUY_TIER_HOLD");
    assert.equal(gate.evaluateEntry(token, { hasDecision: true, excludeFromTrending: false, action: "BUY", decayFraction: 0.5 }, config, 0).reason, "DECISION_TOO_STALE");
    assert.equal(gate.evaluateEntry(token, { hasDecision: true, excludeFromTrending: false, action: "BUY", decayFraction: 1, confidence: 10 }, config, 0).reason, "CONFIDENCE_BELOW_FLOOR");
});

test("evaluateEntry rejects when max_open_positions is reached", () => {
    const gate = createEntryGateService(mockRepository());
    const result = gate.evaluateEntry({ token_address: "X" }, freshBuyLive(), config, 5);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "MAX_OPEN_POSITIONS_REACHED");
});

test("two gate instances bound to different repositories are fully isolated", () => {

    const repoA = mockRepository({ openPositions: new Set(["TOKEN1"]) });
    const repoB = mockRepository(); // TOKEN1 has no open position here

    const gateA = createEntryGateService(repoA);
    const gateB = createEntryGateService(repoB);

    const token = { token_address: "TOKEN1" };

    const resultA = gateA.evaluateEntry(token, freshBuyLive(), config, 0);
    const resultB = gateB.evaluateEntry(token, freshBuyLive(), config, 0);

    assert.equal(resultA.eligible, false);
    assert.equal(resultA.reason, "ALREADY_OPEN_FOR_TOKEN");

    assert.equal(resultB.eligible, true); // repoB has no record of this position at all

});

test("cooldown is evaluated per-repository, not globally", () => {

    const recentLossyClose = { reason: "STOP_LOSS", closed_at: new Date().toISOString().slice(0, 19).replace("T", " ") };

    const repoWithCooldown = mockRepository({ lastTrades: new Map([["TOKEN1", recentLossyClose]]) });
    const repoWithoutHistory = mockRepository();

    const gateA = createEntryGateService(repoWithCooldown);
    const gateB = createEntryGateService(repoWithoutHistory);

    const token = { token_address: "TOKEN1" };

    assert.equal(gateA.evaluateEntry(token, freshBuyLive(), config, 0).reason, "COOLDOWN_ACTIVE_STOP_LOSS");
    assert.equal(gateB.evaluateEntry(token, freshBuyLive(), config, 0).eligible, true);

});
