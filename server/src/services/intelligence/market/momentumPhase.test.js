// services/intelligence/market/momentumPhase.test.js - proves each of
// the six real momentum phases classifies correctly from real, already-
// collected data shapes. SPRINT 12 (Arjuna V5) CTO DECISION (FINAL):
// this module is a pure SCORING MODIFIER now - it never returns a
// riskReason/veto of any kind (that coupling, from FINAL PRODUCTION
// SPRINT P0, was explicitly reversed by this sprint's CTO decision
// because it could push a token toward a HIGH-risk hard-reject purely on
// momentum). score()'s score/max are always 0 - the phase's real point
// value (config/scoringConfig.js's entryScore.momentumModifier) is
// looked up and applied separately by
// researchEngineFactory.js's computeUnifiedEntryScore (see that file's
// own tests for the applied-modifier proof).
//
// Sprint 15 (Scientific Decision Framework), Phase 2 - Repository
// Boundary Migration: classifyMomentumPhase/score no longer read
// tokenPriceHistoryRepository themselves (see this module's own header) -
// `peak` is now passed in directly by the caller
// (researchEngineFactory.js's Context Builder in production). These
// tests pass real peak values as plain numbers instead of seeding/
// querying the real DB - same real scenarios, no DB dependency left to
// exercise now that the function under test doesn't have one either.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { score, classifyMomentumPhase } = require("./momentumPhase");

function realToken(overrides = {}){
    return {
        token_address: `TestMomentumPhaseToken${crypto.randomBytes(6).toString("hex")}`,
        price: 1.0, price_change_5m: 0, price_change_1h: 0,
        buys_5m: null, sells_5m: null,
        ...overrides
    };
}

test("EARLY_MOMENTUM: no price history at all - never penalized for lacking a track record", () => {
    const token = realToken({ price_change_5m: 3, price_change_1h: 8 });
    const result = classifyMomentumPhase(token, null, null);
    assert.equal(result.phase, "EARLY_MOMENTUM");
    assert.equal(result.facts.peak, null);
    assert.equal(result.facts.drawdownFromPeak, null);
});

test("EARLY_MOMENTUM: real price history exists but current price is at/near its own peak", () => {
    const token = realToken({ price: 0.98, price_change_5m: 2, price_change_1h: 5 });
    const result = classifyMomentumPhase(token, null, 1.0); // peak 1.0, drawdown 2% - well under the 15% floor
    assert.equal(result.phase, "EARLY_MOMENTUM");
    assert.ok(Math.abs(result.facts.drawdownFromPeak - 0.02) < 1e-9);
});

test("HEALTHY_MOMENTUM: an established move with a moderate pullback from peak and price still genuinely rising", () => {
    const token = realToken({ price: 0.85, price_change_5m: 1, price_change_1h: 3 });
    const result = classifyMomentumPhase(token, null, 1.0); // 15% drawdown - above EARLY floor, below DEAD_BOUNCE floor
    assert.equal(result.phase, "HEALTHY_MOMENTUM");
});

test("NORMAL: a moderate pullback from peak with price flat/negative - the true neutral default, distinct from HEALTHY_MOMENTUM", () => {
    const token = realToken({ price: 0.85, price_change_5m: -1, price_change_1h: -2 });
    const result = classifyMomentumPhase(token, null, 1.0); // same drawdown shape as the HEALTHY_MOMENTUM case, but not rising
    assert.equal(result.phase, "NORMAL");
});

test("DEAD_BOUNCE: down 50%+ from its own real peak, 5m ticking up but the 1h trend is still negative", () => {
    const token = realToken({ price: 0.4, price_change_5m: 4, price_change_1h: -12 });
    const result = classifyMomentumPhase(token, null, 1.0); // peak 1.0, now 0.4 = 60% drawdown
    assert.equal(result.phase, "DEAD_BOUNCE");
    assert.ok(Math.abs(result.facts.drawdownFromPeak - 0.6) < 1e-9);
});

test("POST_RUG_RECOVERY: down 70%+ from its own real peak, but BOTH 5m and 1h are genuinely positive", () => {
    const token = realToken({ price: 0.25, price_change_5m: 5, price_change_1h: 20 });
    const result = classifyMomentumPhase(token, null, 1.0); // peak 1.0, now 0.25 = 75% drawdown
    assert.equal(result.phase, "POST_RUG_RECOVERY");
});

test("EXIT_LIQUIDITY: price rising but real 24h net buy pressure is negative", () => {
    const token = realToken({ price: 1.1, price_change_5m: 3, price_change_1h: 10 });
    const trenchesEntry = { net_buy_24h: -50000 };
    const result = classifyMomentumPhase(token, trenchesEntry, null);
    assert.equal(result.phase, "EXIT_LIQUIDITY");
});

test("EXIT_LIQUIDITY: price rising but real 5m sell volume exceeds buy volume", () => {
    const token = realToken({ price: 1.1, price_change_5m: 3, price_change_1h: 10, buys_5m: 4000, sells_5m: 9000 });
    const result = classifyMomentumPhase(token, null, null);
    assert.equal(result.phase, "EXIT_LIQUIDITY");
});

test("EXIT_LIQUIDITY takes priority over DEAD_BOUNCE/POST_RUG_RECOVERY when both real signals are present", () => {
    const token = realToken({ price: 0.25, price_change_5m: 5, price_change_1h: 20 });
    const trenchesEntry = { net_buy_24h: -10000 }; // real orderflow says money is leaving despite the price tick
    const result = classifyMomentumPhase(token, trenchesEntry, 1.0); // would otherwise be POST_RUG_RECOVERY
    assert.equal(result.phase, "EXIT_LIQUIDITY");
});

test("a real positive move that is neither an early high nor a bounce/recovery/exit-liquidity shape is HEALTHY_MOMENTUM, not silently reclassified", () => {
    const token = realToken({ price: 0.7, price_change_5m: 2, price_change_1h: 6 });
    const result = classifyMomentumPhase(token, { net_buy_24h: 5000 }, 1.0); // 30% drawdown - real but moderate
    assert.equal(result.phase, "HEALTHY_MOMENTUM");
});

test("a real peak is ignored when the token has no current price (preserves the original never-look-up-without-a-price guard)", () => {
    const token = realToken({ price: null, price_change_5m: 2, price_change_1h: 5 });
    // A non-null peak is passed in, but must be treated as absent because
    // price is null - exactly what the pre-Phase-2 code did by never even
    // querying the repository in this case.
    const result = classifyMomentumPhase(token, null, 1.0);
    assert.equal(result.facts.peak, null);
    assert.equal(result.facts.drawdownFromPeak, null);
});

// SPRINT 12 (Arjuna V5): score() is a pure SCORING MODIFIER carrier now -
// it never vetoes, never returns a risk reason of any kind, for ANY
// phase including the three that used to. The real point value lives in
// config/scoringConfig.js and is applied by
// researchEngineFactory.js's computeUnifiedEntryScore, not here.
test("score() never contributes to the unified entry score directly (max always 0) and never returns a risk reason of any kind, for any phase", () => {
    const cleanToken = realToken({ price_change_5m: 2, price_change_1h: 5 });
    const cleanResult = score(cleanToken, null, null);
    assert.equal(cleanResult.score, 0);
    assert.equal(cleanResult.max, 0);
    assert.equal(cleanResult.hasData, true);
    assert.equal(cleanResult.riskReasons, undefined, "momentumPhase.js must never expose riskReasons - that coupling was explicitly reversed by this sprint's CTO decision");
    assert.equal(cleanResult.phase, "EARLY_MOMENTUM");

    const exitLiquidityToken = realToken({ price: 1.1, price_change_5m: 3, price_change_1h: 10 });
    const riskyResult = score(exitLiquidityToken, { net_buy_24h: -1 }, null);
    assert.equal(riskyResult.score, 0);
    assert.equal(riskyResult.max, 0);
    assert.equal(riskyResult.phase, "EXIT_LIQUIDITY");
    assert.equal(riskyResult.riskReasons, undefined);
});
