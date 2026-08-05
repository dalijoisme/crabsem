// services/replayEngine.test.js - Sprint 15 (Scientific Decision
// Framework), Phase 7. Proves replayDecision/replayMany reproduce the
// real original decision from stored evidence, handle a genuinely
// unreplayable record honestly (null, never a fabricated result), and
// that a different override genuinely produces a different real signal -
// proving replay isn't just returning the stored numbers back unchanged.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const replayEngine = require("./replayEngine");
const decisionEvidenceService = require("./decisionEvidenceService");
const decisionEvidenceRepository = require("../repositories/decisionEvidenceRepository");
const db = require("../database/connection");

const PREFIX = "REPLAYENGINE_TEST_";

test.after(() => {
    db.prepare("DELETE FROM decision_evidence WHERE token_address LIKE ?").run(`${PREFIX}%`);
});

function realToken(address){
    return {
        token_address: address, price: 0.001, market_cap: 1000000, liquidity: 50000, holders: 200,
        volume_1h: 30000, price_change_1h: 20, price_change_5m: 1,
        updated_at: new Date().toISOString().slice(0, 19).replace("T", " ")
    };
}

test("replayDecision returns null (never throws) for a decision id that doesn't exist", () => {
    assert.equal(replayEngine.replayDecision(999999999), null);
});

test("replayDecision returns null when Foundation Tier never captured a real token", () => {
    const id = decisionEvidenceRepository.insertDecisionEvidence({
        tokenAddress: `${PREFIX}NOTOKEN`, decisionEvidenceSchemaVersion: 1,
        foundationTierJson: JSON.stringify({ trenches: null })
    });
    assert.equal(replayEngine.replayDecision(id), null);
});

test("replayDecision reproduces the real original action/score from a genuinely captured decision", () => {
    const token = realToken(`${PREFIX}REPRODUCE`);
    const trenchesEntry = { net_buy_24h: 5000, buys_24h: 80, sells_24h: 20, rug_ratio: 0.1, top_10_holder_rate: 0.2, is_honeypot: 0, smart_degen_count: 0 };
    const researchEngineFactory = require("./researchEngineFactory");
    const liveCtx = researchEngineFactory.preloadContext([token]);
    liveCtx.trenchesByAddress.set(token.token_address, trenchesEntry);
    const [liveSignal] = researchEngineFactory.analyzeTokensWithOverride([token], liveCtx, "momentumHunter", null);

    const id = decisionEvidenceService.captureDecisionEvidence({ token, trenchesEntry, live: liveSignal, config: {} });

    const result = replayEngine.replayDecision(id);
    assert.ok(result, "a genuinely captured decision must replay successfully");
    assert.equal(result.replayedSignal.action, liveSignal.action);
    assert.equal(result.replayedSignal.participantScore, liveSignal.participantScore);
    assert.equal(result.originalAction, liveSignal.action, "the original action recorded on the decision_evidence row must match too");
});

test("replayDecision through a real, different override produces a genuinely different real signal, not the stored value replayed back unchanged", () => {
    const token = realToken(`${PREFIX}OVERRIDE`);
    const trenchesEntry = { net_buy_24h: 5000, buys_24h: 80, sells_24h: 20, rug_ratio: 0.1, top_10_holder_rate: 0.2, is_honeypot: 0, smart_degen_count: 0 };
    const id = decisionEvidenceService.captureDecisionEvidence({ token, trenchesEntry, live: { action: "BUY", confidence: 80 }, config: {} });

    const baseline = replayEngine.replayDecision(id);
    const reweighted = replayEngine.replayDecision(id, { override: { weights: { accumulation: 5 } } });

    assert.notEqual(baseline.replayedSignal.breakdown.participant.accumulation.max, reweighted.replayedSignal.breakdown.participant.accumulation.max, "a genuinely different override must produce a genuinely different real breakdown, proving replay actually re-runs the engine");
});

test("replayMany replays every real decision it can and silently skips (never throws for) ones it can't", () => {
    const token = realToken(`${PREFIX}BATCH`);
    const id = decisionEvidenceService.captureDecisionEvidence({ token, live: { action: "BUY" }, config: {} });
    const results = replayEngine.replayMany([id, 999999999, id]);
    assert.equal(results.length, 2, "the two real, replayable ids should succeed; the fake one should be silently skipped");
});
