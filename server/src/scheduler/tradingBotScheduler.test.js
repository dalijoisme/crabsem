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
const freshUniverseService = require("../services/freshUniverseService");
const tradingBotFreshUniverseSnapshotRepository = require("../repositories/tradingBotFreshUniverseSnapshotRepository");

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
        stub(freshUniverseService, "getBuyCandidateUniverse", () => ({
            tokens, collectorTotalCount: tokens.length, freshUniverseCount: tokens.length, maxAgeSeconds: 120, minMarketCap: 0
        })),
        stub(tradingBotFreshUniverseSnapshotRepository, "insertSnapshot", () => {}),
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

// Fresh BUY Universe RFC (approved architecture: misty-floating-quasar.md):
// proves tick() now builds its per-tick universe via
// freshUniverseService.getBuyCandidateUniverse() - never
// gmgnTokenRepository.getAllTokens() directly - and records exactly one
// fresh-universe snapshot per tick via
// tradingBotFreshUniverseSnapshotRepository.insertSnapshot().
test("tick() sources tokens from freshUniverseService (never getAllTokens directly) and records one fresh-universe snapshot per tick", async () => {

    const tokens = [{ token_address: "TOKEN_A", market_cap: 1000000 }];

    let getAllTokensCalled = false;
    const originalGetAllTokens = gmgnTokenRepository.getAllTokens;
    gmgnTokenRepository.getAllTokens = () => { getAllTokensCalled = true; return tokens; };

    let getBuyCandidateUniverseCalled = false;
    const snapshotCalls = [];

    const restores = [
        () => { gmgnTokenRepository.getAllTokens = originalGetAllTokens; },
        stub(freshUniverseService, "getBuyCandidateUniverse", () => {
            getBuyCandidateUniverseCalled = true;
            return { tokens, collectorTotalCount: 14023, freshUniverseCount: tokens.length, maxAgeSeconds: 120, minMarketCap: 0 };
        }),
        stub(tradingBotFreshUniverseSnapshotRepository, "insertSnapshot", (args) => snapshotCalls.push(args)),
        // Fresh, never-before-used userId in this file - the earlier test
        // above already ran tick() for userIds 1/2/3, which set their
        // module-level lastCycleAtByUser to "just now"; reusing any of
        // those ids here would make isDue() false (not enough of
        // scan_interval_seconds elapsed between the two tests), and this
        // test would wrongly appear to do nothing.
        stub(tradingBotRepository, "findRunningUserIds", () => [101]),
        stub(tradingBotRepository, "getConfig", () => ({ scan_interval_seconds: 1, ...strategyProfileConfig.resolveProfile("STABLE") })),
        stub(liveRecommendationService, "computeStructuralExclusion", () => ({ excluded: false, reason: null, tokenStatus: null })),
        stub(scoringWorkerPool, "scoreTokens", async (tokensArg) => tokensArg.map(() => ({ action: "HOLD", confidence: 10, risk: "LOW", participantScore: 20, marketHealth: 50 }))),
        stub(tradingBotEngine, "runCycle", async (userId, tokensArg) => ({ scanned: tokensArg.length, opened: 0, closed: 0, skipped: 0, skipReasons: {} }))
    ];

    try{
        await scheduler.tick();
    }
    finally{
        restores.forEach(restore => restore());
    }

    assert.equal(getBuyCandidateUniverseCalled, true, "tick() must source its universe from freshUniverseService.getBuyCandidateUniverse()");
    assert.equal(getAllTokensCalled, false, "tick() must never call gmgnTokenRepository.getAllTokens() directly anymore");
    assert.equal(snapshotCalls.length, 1, "exactly one fresh-universe snapshot must be recorded per tick");
    assert.deepEqual(snapshotCalls[0], { collectorTotalCount: 14023, freshUniverseCount: 1, maxAgeSeconds: 120, minMarketCap: 0 });

});

// BUY-halt root-cause fix: a real production incident (2026-07-31
// 15:11:51 -> 2026-08-01) where this exact scheduler's own tick() -
// along with every other scheduler in the same process - silently
// stopped running for hours. trading_bot_state.status stayed 'RUNNING'
// throughout (a static DB flag, never revalidated against a live tick),
// so nothing anywhere could prove BUY had stopped because this
// scheduler itself had died, as opposed to every real candidate
// genuinely being rejected. getTickHealth() (read by services/health.js)
// must reflect a real, just-updated timestamp after every tick() -
// including the cheap "no RUNNING users" no-op path, since a dead
// process can't tell "no users" apart from "never got a chance to
// check", and this heartbeat exists to prove liveness independent of
// what any given tick finds.
test("getTickHealth reflects a real, just-updated timestamp after every tick(), even the no-RUNNING-users no-op path", async () => {

    const restores = [ stub(tradingBotRepository, "findRunningUserIds", () => []) ];

    try{

        const before = scheduler.getTickHealth();
        assert.equal(before.stuck, false, "never having ticked yet must never itself count as stuck");

        const beforeTickAt = Date.now();
        await scheduler.tick();

        const after = scheduler.getTickHealth();
        assert.ok(after.lastTickFinishedAt, "a real ISO timestamp must be recorded after tick() completes");
        assert.ok(Date.parse(after.lastTickFinishedAt) >= beforeTickAt, "the recorded timestamp must be from this actual tick, not a stale/fabricated one");
        assert.equal(after.secondsSinceLastFinish, 0);
        assert.equal(after.stuck, false, "a tick that just completed must never be reported as stuck");
        assert.equal(after.currentTickStartedAt, null, "a completed tick must not still show as in-progress");
        assert.equal(after.lastTickError, null);

    }
    finally{
        restores.forEach(restore => restore());
    }

});

// A tick that genuinely throws (e.g. freshUniverseService itself
// failing) must still leave a real, queryable heartbeat behind - the
// whole point of putting getTickHealth() ahead of a dead process is that
// it must survive the FAILURE case too, not only the happy path.
test("getTickHealth records the real error and still updates lastTickFinishedAt when a tick throws", async () => {

    const restores = [
        stub(tradingBotRepository, "findRunningUserIds", () => { throw new Error("simulated DB failure"); })
    ];

    try{

        await assert.rejects(() => scheduler.tick(), /simulated DB failure/);

        const health = scheduler.getTickHealth();
        assert.equal(health.lastTickError, "simulated DB failure");
        assert.ok(health.lastTickFinishedAt);
        assert.equal(health.currentTickStartedAt, null);

    }
    finally{
        restores.forEach(restore => restore());
    }

});
