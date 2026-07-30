// scheduler/tradingBotScheduler.test.js - Finding B regression test:
// liveByAddress used to be computed ONCE per tick against a single
// hardcoded STABLE philosophy (predictionValidationService.js's "house"
// cache), silently discarding every other strategy_profile's weights/
// tiers/acceleration_overrides for entry scoring. Proves the fix: each
// due user's OWN translated philosophy now drives their OWN
// scoreTokens() call (deduped per distinct profile, mirroring
// services/benchmarkRunner.js's profileKeyFor), and that a STABLE user's
// resulting philosophy/signal is unchanged from before the fix.
//
// Pure wiring test - every dependency is stubbed at the module-object
// level (no real DB rows, no real worker thread). The scoring MATH
// itself (weights/tiers/acceleration bonus/entry gate) is already
// covered by researchEngineFactory.test.js/strategyProfileTranslator.test.js;
// this file only proves WHICH philosophy each user's entry signal is
// computed from. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const tradingBotRepository = require("../repositories/tradingBotRepository");
const scoringWorkerPool = require("../services/scoringWorkerPool");
const liveRecommendationService = require("../services/liveRecommendationService");
const tradingBotEngine = require("../services/tradingBotEngine");
const strategyProfileTranslator = require("../services/strategyProfileTranslator");
const strategyProfileConfig = require("../config/strategyProfileConfig");

const scheduler = require("./tradingBotScheduler");

function stub(obj, method, fn){
    const original = obj[method];
    obj[method] = fn;
    return () => { obj[method] = original; };
}

test("each due user's OWN strategy_profile philosophy drives their OWN entry-scoring pass, deduped per distinct profile, and STABLE is unaffected", async () => {

    const tokens = [{ token_address: "TOKEN_A", market_cap: 1000000 }];

    // Users 1 and 3 are both STABLE (must dedup to one scoring pass);
    // user 2 is AGGRESSIVE (must get its own, separately-scored signal).
    const configsByUser = {
        1: { scan_interval_seconds: 1, ...strategyProfileConfig.resolveProfile("STABLE") },
        2: { scan_interval_seconds: 1, ...strategyProfileConfig.resolveProfile("AGGRESSIVE") },
        3: { scan_interval_seconds: 1, ...strategyProfileConfig.resolveProfile("STABLE") }
    };

    const restores = [
        stub(gmgnTokenRepository, "getAllTokens", () => tokens),
        stub(tradingBotRepository, "findRunningUserIds", () => [1, 2, 3]),
        stub(tradingBotRepository, "getConfig", (userId) => configsByUser[userId]),
        stub(liveRecommendationService, "computeStructuralExclusion", () => ({ excluded: false, reason: null, tokenStatus: null }))
    ];

    const scoreTokensCalls = [];
    restores.push(stub(scoringWorkerPool, "scoreTokens", async (tokensArg, philosophy) => {
        scoreTokensCalls.push(philosophy);
        // Distinguish the two profiles' output purely by whether THIS
        // philosophy carries AGGRESSIVE's acceleration override -
        // proves the acceleration-based philosophy is what's actually
        // driving the difference, not some other unrelated field.
        const isAggressive = Boolean(philosophy.acceleration);
        return tokensArg.map(() => ({
            action: isAggressive ? "STRONG BUY" : "HOLD",
            confidence: isAggressive ? 90 : 10,
            risk: "LOW",
            participantScore: isAggressive ? 95 : 20,
            marketHealth: 50
        }));
    }));

    const runCycleLiveByUser = new Map();
    restores.push(stub(tradingBotEngine, "runCycle", async (userId, tokensArg, liveByAddress) => {
        runCycleLiveByUser.set(userId, liveByAddress);
        return { scanned: tokensArg.length, opened: 0, closed: 0, skipped: 0, skipReasons: {} };
    }));

    try{
        await scheduler.tick();
    }
    finally{
        restores.forEach(restore => restore());
    }

    assert.equal(scoreTokensCalls.length, 2, "exactly two DISTINCT profiles (STABLE, AGGRESSIVE) among three due users must trigger exactly two scoring passes");

    const stableLive1 = runCycleLiveByUser.get(1)?.get("TOKEN_A");
    const aggressiveLive = runCycleLiveByUser.get(2)?.get("TOKEN_A");
    const stableLive3 = runCycleLiveByUser.get(3)?.get("TOKEN_A");

    assert.ok(stableLive1, "STABLE user 1 must receive a live entry signal");
    assert.ok(aggressiveLive, "AGGRESSIVE user 2 must receive a live entry signal");
    assert.ok(stableLive3, "STABLE user 3 must receive a live entry signal");

    // The core bug this fixes: AGGRESSIVE's own philosophy must actually
    // participate in entry scoring, producing a genuinely different
    // signal than STABLE's - not silently reused from a single
    // hardcoded STABLE computation.
    assert.equal(aggressiveLive.action, "STRONG BUY");
    assert.equal(aggressiveLive.hasDecision, true);
    assert.notDeepEqual(aggressiveLive, stableLive1);

    // Two users on the IDENTICAL profile must reuse the SAME computed
    // map (not just equal contents) - proves the dedup, not two
    // redundant scoring passes that happened to agree.
    assert.equal(runCycleLiveByUser.get(1), runCycleLiveByUser.get(3));
    assert.equal(stableLive1.action, "HOLD");

    // STABLE's translated philosophy passed to scoreTokens must be
    // byte-identical to what predictionValidationService.js's own
    // "house" cache already computes today - proves STABLE users are
    // genuinely unaffected by this fix, not just "still passing by
    // coincidence".
    const expectedStablePhilosophy = strategyProfileTranslator.translate(strategyProfileConfig.resolveProfile("STABLE")).philosophy;
    const observedStablePhilosophy = scoreTokensCalls.find(p => !p.acceleration);
    assert.deepEqual(observedStablePhilosophy, expectedStablePhilosophy);

    const expectedAggressivePhilosophy = strategyProfileTranslator.translate(strategyProfileConfig.resolveProfile("AGGRESSIVE")).philosophy;
    const observedAggressivePhilosophy = scoreTokensCalls.find(p => p.acceleration);
    assert.deepEqual(observedAggressivePhilosophy, expectedAggressivePhilosophy);
    assert.equal(observedAggressivePhilosophy.acceleration.requireGateForEntry, true);

});
