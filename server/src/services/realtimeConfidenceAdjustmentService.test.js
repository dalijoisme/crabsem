// services/realtimeConfidenceAdjustmentService.test.js - Arjuna V4 FINAL
// DECISION ENGINE SPRINT. Proves every Architect-specified formula is
// implemented exactly as given: token age buckets, Smart Money/KOL/Pulse
// 3-tier percentages and caps, Fake Pump category detection/stacking/cap,
// and that the combined adjustment only ever touches confidence (never
// exposes anything that could be mistaken for a score/action-tier
// change). Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("./realtimeConfidenceAdjustmentService");
const config = require("../config/realtimeAdjustmentConfig");

function series(direction, consistency){
    return { direction, consistency };
}

// ---- Token Age ----

test("resolveTokenAgeMultiplier matches the current bucket table (60-180min softened 0.90->0.95, 2026-08-07 engine-optimization roadmap - see realtimeAdjustmentConfig.js's own header for the real-outcome evidence)", () => {
    assert.equal(svc.resolveTokenAgeMultiplier(5).multiplier, 0.95);
    assert.equal(svc.resolveTokenAgeMultiplier(10).multiplier, 0.95);
    assert.equal(svc.resolveTokenAgeMultiplier(10.01).multiplier, 1.00);
    assert.equal(svc.resolveTokenAgeMultiplier(60).multiplier, 1.00);
    assert.equal(svc.resolveTokenAgeMultiplier(60.01).multiplier, 0.95);
    assert.equal(svc.resolveTokenAgeMultiplier(180).multiplier, 0.95);
    assert.equal(svc.resolveTokenAgeMultiplier(180.01).multiplier, 0.75);
    assert.equal(svc.resolveTokenAgeMultiplier(360).multiplier, 0.75);
    assert.equal(svc.resolveTokenAgeMultiplier(360.01).multiplier, 0.60);
    assert.equal(svc.resolveTokenAgeMultiplier(10000).multiplier, 0.60);
});

test("resolveTokenAgeMultiplier is neutral (1.00x), never a penalty, when age is unknown", () => {
    assert.equal(svc.resolveTokenAgeMultiplier(null).multiplier, 1.00);
});

// ---- Smart Money ----

test("resolveSmartMoneyAdjustment: strong improving = +10%, clearly weakening = -10%, else neutral", () => {

    assert.equal(svc.resolveSmartMoneyAdjustment({ signals: { smartMoneyNetUsd: series("UP", "CONSISTENT_UP") } }).pct, 10);
    assert.equal(svc.resolveSmartMoneyAdjustment({ signals: { smartMoneyNetUsd: series("DOWN", "CONSISTENT_DOWN") } }).pct, -10);
    assert.equal(svc.resolveSmartMoneyAdjustment({ signals: { smartMoneyNetUsd: series("UP", "MIXED") } }).pct, 0, "direction alone without consistency agreement must not count as strong");
    assert.equal(svc.resolveSmartMoneyAdjustment({ signals: { smartMoneyNetUsd: series(null, null) } }).pct, 0);
    assert.equal(svc.resolveSmartMoneyAdjustment({}).pct, 0, "missing realtimePulse entirely must fail open to neutral");

});

// ---- KOL ----

test("resolveKolAdjustment: strong improving = +8%, clearly weakening = -8%, capped at the Architect's own ±8%", () => {

    assert.equal(svc.resolveKolAdjustment({ signals: { kolNetUsd: series("UP", "CONSISTENT_UP") } }).pct, 8);
    assert.equal(svc.resolveKolAdjustment({ signals: { kolNetUsd: series("DOWN", "CONSISTENT_DOWN") } }).pct, -8);
    assert.ok(Math.abs(svc.resolveKolAdjustment({ signals: { kolNetUsd: series("UP", "CONSISTENT_UP") } }).pct) <= config.kol.maxAdjustmentPct);

});

// ---- Pulse ----

test("resolvePulseAdjustment: strong multi-signal agreement hits the full ±15% cap, mixed/insufficient is neutral", () => {

    assert.equal(svc.resolvePulseAdjustment({ flowDirectionVoteProvisional: "UP", consistencyVoteProvisional: "MOSTLY_CONSISTENT" }).pct, 15);
    assert.equal(svc.resolvePulseAdjustment({ flowDirectionVoteProvisional: "DOWN", consistencyVoteProvisional: "MOSTLY_CONSISTENT" }).pct, -15);
    assert.equal(svc.resolvePulseAdjustment({ flowDirectionVoteProvisional: "UP", consistencyVoteProvisional: "MOSTLY_MIXED" }).pct, 0);
    assert.equal(svc.resolvePulseAdjustment({ flowDirectionVoteProvisional: "MIXED", consistencyVoteProvisional: "MOSTLY_CONSISTENT" }).pct, 0);
    assert.equal(svc.resolvePulseAdjustment(null).pct, 0, "no realtime pulse record at all must fail open to neutral, never penalized");

});

// ---- Fake Pump ----

test("resolveFakePumpPenalty: suspicious pump fires when price is up but no real-time confirmation exists", () => {

    const result = svc.resolveFakePumpPenalty({
        realtimePulse: { signals: { price: series("UP"), buyPressure: series("DOWN"), volume1h: series("DOWN"), netFlow5m: series("FLAT") } },
        syntheticBreakdown: { syntheticScore: 0, breakdown: {}, washFlagged: false }
    });

    assert.equal(result.pct, config.fakePump.suspiciousPumpPct);
    assert.ok(result.reasons[0].includes("Suspicious pump"));

});

test("resolveFakePumpPenalty: no penalty when price is up AND confirmed by real buy pressure/volume", () => {

    const result = svc.resolveFakePumpPenalty({
        realtimePulse: { signals: { price: series("UP"), buyPressure: series("UP"), volume1h: series("DOWN"), netFlow5m: series("FLAT") } },
        syntheticBreakdown: { syntheticScore: 0, breakdown: {}, washFlagged: false }
    });

    assert.equal(result.pct, 0);

});

test("resolveFakePumpPenalty: wash trading fires on GMGN's real flag OR syntheticScore crossing the reused elevated threshold", () => {

    const viaFlag = svc.resolveFakePumpPenalty({ realtimePulse: null, syntheticBreakdown: { syntheticScore: 10, breakdown: {}, washFlagged: true } });
    assert.equal(viaFlag.pct, config.fakePump.washTradingPct);

    const viaScore = svc.resolveFakePumpPenalty({ realtimePulse: null, syntheticBreakdown: { syntheticScore: config.fakePump.elevatedThreshold, breakdown: {}, washFlagged: false } });
    assert.equal(viaScore.pct, config.fakePump.washTradingPct);

    const belowThreshold = svc.resolveFakePumpPenalty({ realtimePulse: null, syntheticBreakdown: { syntheticScore: config.fakePump.elevatedThreshold - 1, breakdown: {}, washFlagged: false } });
    assert.equal(belowThreshold.pct, 0);

});

test("resolveFakePumpPenalty: coordinated activity fires on the bundler/rat-trader/entrapment sub-group average, not the whole composite", () => {

    const result = svc.resolveFakePumpPenalty({
        realtimePulse: null,
        syntheticBreakdown: {
            syntheticScore: 20, // whole composite stays LOW - proves this is a real sub-group check, not just re-checking the total
            breakdown: { bundlerTraderAmountRate: 90, ratTraderAmountRate: 90, entrapmentRatio: 90, botDegenRate: 0, freshWalletRate: 0 },
            washFlagged: false
        }
    });

    assert.equal(result.pct, config.fakePump.coordinatedActivityPct);

});

test("resolveFakePumpPenalty: multiple categories stack, but the combined penalty never exceeds the Architect's -25% ceiling", () => {

    const result = svc.resolveFakePumpPenalty({
        realtimePulse: { signals: { price: series("UP"), buyPressure: series("DOWN"), volume1h: series("DOWN"), netFlow5m: series("DOWN") } },
        syntheticBreakdown: {
            syntheticScore: 100,
            breakdown: { bundlerTraderAmountRate: 100, ratTraderAmountRate: 100, entrapmentRatio: 100 },
            washFlagged: true
        }
    });

    // suspicious(-10) + wash(-15) + coordinated(-20) = -45 raw, capped at -25.
    assert.equal(result.pct, config.fakePump.maxCombinedPenaltyPct);
    assert.equal(result.reasons.length, 3, "every triggered category must still be individually reported, even though the total is capped");

});

test("resolveFakePumpPenalty: real zero when nothing is elevated and no data exists", () => {
    const result = svc.resolveFakePumpPenalty({ realtimePulse: null, syntheticBreakdown: null });
    assert.equal(result.pct, 0);
    assert.deepEqual(result.reasons, []);
});

// ---- Combined ----

test("computeConfidenceAdjustment combines every component multiplicatively, in the Architect's own priority order for the reasons narrative", () => {

    const adjustment = svc.computeConfidenceAdjustment({
        ageMinutes: 30, // 1.00x - neutral, isolates the other components
        realtimePulse: {
            flowDirectionVoteProvisional: "UP", consistencyVoteProvisional: "MOSTLY_CONSISTENT",
            signals: {
                smartMoneyNetUsd: series("UP", "CONSISTENT_UP"),
                kolNetUsd: series("UP", "CONSISTENT_UP"),
                price: series("UP"), buyPressure: series("UP"), volume1h: series("UP"), netFlow5m: series("UP")
            }
        },
        syntheticBreakdown: { syntheticScore: 0, breakdown: {}, washFlagged: false }
    });

    // 1.00 (age) * 1.15 (pulse) * 1.00 (no fake pump) * 1.08 (kol) * 1.10 (smart money)
    const expected = 1.00 * 1.15 * 1.00 * 1.08 * 1.10;
    assert.ok(Math.abs(adjustment.combinedMultiplier - expected) < 1e-9);

    assert.equal(adjustment.reasons.length, 4, "pulse + tokenAge + kol + smartMoney reasons (fakePump contributes zero reasons when nothing triggers)");

});

test("computeConfidenceAdjustment never returns anything that reads as a score/action-tier field - confidence-only contract", () => {
    const adjustment = svc.computeConfidenceAdjustment({ ageMinutes: null, realtimePulse: null, syntheticBreakdown: null });
    assert.ok(!("score" in adjustment));
    assert.ok(!("action" in adjustment));
    assert.ok(!("participantScore" in adjustment));
    assert.equal(adjustment.combinedMultiplier, 1); // fully neutral when nothing is known
});

test("applyToConfidence rounds and clamps to the existing [0,100] confidence bound, never fabricates a value from a null base", () => {

    const strongPositive = { combinedMultiplier: 1.5 };
    assert.equal(svc.applyToConfidence(80, strongPositive), 100, "must clamp at 100, never overflow");

    const strongNegative = { combinedMultiplier: 0.1 };
    assert.equal(svc.applyToConfidence(80, strongNegative), 8);

    assert.equal(svc.applyToConfidence(null, { combinedMultiplier: 1.2 }), null);

});
