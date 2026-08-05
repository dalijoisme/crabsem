// services/replayValidation.test.js - Sprint 15 (Scientific Decision
// Framework), Phase 9. The final, explicit verification of the four
// things Batch 3 requires proof of:
//   1. Replay is fully offline.
//   2. Replay matches production.
//   3. No repository access exists inside the parts of the Decision
//      Pipeline this sprint actually migrated (honest about what's not
//      yet true, not a blanket claim).
//   4. Context Contract is satisfied everywhere a ctx gets built.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const researchEngineFactory = require("./researchEngineFactory");
const replayEngine = require("./replayEngine");
const decisionEvidenceService = require("./decisionEvidenceService");
const decisionEvidenceRepository = require("../repositories/decisionEvidenceRepository");
const db = require("../database/connection");

const PREFIX = "REPLAYVALIDATION_TEST_";

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

// ==========================================================
// 1. REPLAY IS FULLY OFFLINE
// ==========================================================
// Every real repository preloadContext() (the LIVE builder) would ever
// touch is temporarily replaced with a throwing stub, for the DURATION
// of a real replayDecision() call only. If replay is genuinely offline,
// none of them fire and nothing throws. This is not an assertion of
// intent - it is a real trap that would fail loudly if replay ever
// regressed to calling a repository directly, the same way
// replayContextBuilder's own realtimePulseByAddress bug was actually
// caught in Batch 2, not merely asserted away.
test("replaying a real decision touches zero live repositories - a trap, not an assertion of intent", () => {

    const token = realToken(`${PREFIX}OFFLINE`);
    const id = decisionEvidenceService.captureDecisionEvidence({
        token, trenchesEntry: { net_buy_24h: 100, buys_24h: 5, sells_24h: 2 }, live: { action: "BUY" }, config: {}
    });

    const repos = {
        gmgnTrenchesRepository: require("../repositories/gmgnTrenchesRepository"),
        gmgnActivityFeedRepository: require("../repositories/gmgnActivityFeedRepository"),
        gmgnHotSearchesRepository: require("../repositories/gmgnHotSearchesRepository"),
        gmgnLaunchpadStatsRepository: require("../repositories/gmgnLaunchpadStatsRepository"),
        gmgnOndemandCacheRepository: require("../repositories/gmgnOndemandCacheRepository"),
        walletRepository: require("../repositories/walletRepository"),
        tokenPriceHistoryRepository: require("../repositories/tokenPriceHistoryRepository")
    };
    const realtimePulseService = require("./realtimePulseService");

    // Every real method each module exposes, methods with a name
    // starting with "build" excluded (buildCacheKey is a pure string
    // helper, no I/O, real callers depend on it working during replay).
    const patched = [];
    for(const [moduleName, mod] of Object.entries(repos)){
        for(const fnName of Object.keys(mod)){
            if(typeof mod[fnName] !== "function" || fnName.startsWith("build")) continue;
            const original = mod[fnName];
            mod[fnName] = () => { throw new Error(`OFFLINE VIOLATION: ${moduleName}.${fnName} was called during replay`); };
            patched.push({ mod, fnName, original });
        }
    }
    const originalGetLatestSignals = realtimePulseService.getLatestSignals;
    realtimePulseService.getLatestSignals = () => { throw new Error("OFFLINE VIOLATION: realtimePulseService.getLatestSignals was called during replay"); };

    try{
        const result = replayEngine.replayDecision(id);
        assert.ok(result, "replay must still genuinely succeed while every live repository is trapped");
        assert.ok(["BUY", "STRONG BUY", "HOLD", "AVOID"].includes(result.replayedSignal.action));
    }
    finally{
        for(const { mod, fnName, original } of patched) mod[fnName] = original;
        realtimePulseService.getLatestSignals = originalGetLatestSignals;
    }

});

// ==========================================================
// 2. REPLAY MATCHES PRODUCTION
// ==========================================================
test("a replayed decision reproduces the exact original action, participantScore, and per-module breakdown", () => {

    const token = realToken(`${PREFIX}MATCH`);
    const trenchesEntry = { net_buy_24h: 5000, buys_24h: 80, sells_24h: 20, rug_ratio: 0.1, top_10_holder_rate: 0.2, is_honeypot: 0, smart_degen_count: 2 };

    const liveCtx = researchEngineFactory.preloadContext([token]);
    liveCtx.trenchesByAddress.set(token.token_address, trenchesEntry);
    const [liveSignal] = researchEngineFactory.analyzeTokensWithOverride([token], liveCtx, "momentumHunter", null);

    const id = decisionEvidenceService.captureDecisionEvidence({ token, trenchesEntry, live: liveSignal, config: {} });
    const { replayedSignal } = replayEngine.replayDecision(id);

    assert.equal(replayedSignal.action, liveSignal.action);
    assert.equal(replayedSignal.participantScore, liveSignal.participantScore);
    assert.deepEqual(replayedSignal.breakdown.participant.accumulation, liveSignal.breakdown.participant.accumulation);
    assert.deepEqual(replayedSignal.breakdown.market.holderDistribution, liveSignal.breakdown.market.holderDistribution);

});

// ==========================================================
// 3. REPOSITORY BOUNDARY - honest, per-file, not a blanket claim
// ==========================================================
function sourceOf(relativePath){
    return fs.readFileSync(path.join(__dirname, relativePath), "utf8");
}

test("momentumPhase.js contains no repository require at all - the Phase 2 fix holds", () => {
    const src = sourceOf("./intelligence/market/momentumPhase.js");
    assert.ok(!/require\(.*[Rr]epository/.test(src), "momentumPhase.js must never read a repository directly - see its own Sprint 15 Phase 2 header");
});

test("preloadContext is the only function in researchEngineFactory.js that calls a repository - computeStructuralRedFlags/computeAccelerationSignal/analyzeTokenWithPhilosophy must not", () => {
    const src = sourceOf("./researchEngineFactory.js");
    // Every real repository call site in this file (Repository.methodName)
    // - if this list only ever appears inside preloadContext, the
    // functions downstream of it stay ctx-only.
    // .buildCacheKey(...) excluded deliberately - it's a pure string-
    // construction helper (no I/O, confirmed by direct source reading
    // during Sprint 15 Phase 2), called from gatherCachedWalletStats
    // (used by analyzeTokenWithPhilosophy) as well as from inside
    // preloadContext itself - namespaced under gmgnOndemandCacheRepository
    // but not itself a repository READ. Same exclusion the offline-proof
    // test above already applies for the same reason.
    const repoCallPattern = /\b\w*Repository\.(?!buildCacheKey\b)\w+\(/g;
    const matches = src.match(repoCallPattern) || [];
    assert.ok(matches.length > 0, "sanity check - preloadContext itself must still call real repositories");
    // Precise line-scoped check: every matched call site's line number
    // must fall within preloadContext's own function body, not any other
    // function in this file.
    const lines = src.split("\n");
    const preloadStart = lines.findIndex(l => l.includes("function preloadContext("));
    assert.ok(preloadStart >= 0, "preloadContext's own function body must be locatable");
    // Real brace-depth walk, not "first line that trims to '}'" - a naive
    // scan would stop at preloadContext's own FIRST internal block (e.g.
    // a for-loop), which is exactly the false positive this test hit on
    // its first real run against this file's actual source.
    let depth = 0, preloadEnd = -1;
    for(let i = preloadStart; i < lines.length; i++){
        for(const ch of lines[i]){
            if(ch === "{") depth++;
            else if(ch === "}"){ depth--; if(depth === 0){ preloadEnd = i; break; } }
        }
        if(preloadEnd !== -1) break;
    }
    assert.ok(preloadEnd > preloadStart, "preloadContext's real closing brace must be locatable");
    for(let i = 0; i < lines.length; i++){
        if(!repoCallPattern.test(lines[i])) continue;
        repoCallPattern.lastIndex = 0;
        assert.ok(i >= preloadStart && i <= preloadEnd, `a repository call was found outside preloadContext, at line ${i + 1}: ${lines[i].trim()}`);
    }
});

// Documented, TRACKED gaps - not fixed this sprint, carried forward per
// Batch 1/2's own self-reviews. This test exists so the record is a
// checkable fact, not a comment someone has to trust: if any of these
// files ever stop calling a repository directly, THIS test starts
// failing, which is the correct, actionable signal to update Sprint 15's
// own architecture notes rather than letting the record go stale.
test("KNOWN, DEFERRED gap: entryGateService/qualityGateService/opportunityPriorityService/tradeManager still call repositories directly - carried forward, not fixed this sprint", () => {
    const stillViolating = {
        "./entryGateService.js": /gmgnTrenchesRepository\.findByTokenAddress/,
        "./qualityGateService.js": /gmgnTrenchesRepository\.findByTokenAddress/,
        "./opportunityPriorityService.js": /Repository\.\w+\(/,
        "./tradeManager.js": /gmgnTrenchesRepository\.findByTokenAddress/
    };
    for(const [file, pattern] of Object.entries(stillViolating)){
        const src = sourceOf(file);
        assert.ok(pattern.test(src), `${file} was expected to still call a repository directly (documented Sprint 15 gap) - if this now fails, the gap has closed and this sprint's own notes need updating, not this test relaxing`);
    }
});

// ==========================================================
// 4. CONTEXT CONTRACT SATISFIED EVERYWHERE A CTX GETS BUILT
// ==========================================================
test("both real Context Builders self-validate before returning - preloadContext and buildReplayContext", () => {
    const { assertValidContext, CURRENT_CONTEXT_SCHEMA } = require("./contextContract");
    const liveCtx = researchEngineFactory.preloadContext([realToken(`${PREFIX}CONTRACT`)]);
    assert.doesNotThrow(() => assertValidContext(liveCtx, "test-recheck", CURRENT_CONTEXT_SCHEMA));

    const { buildReplayContext } = require("./replayContextBuilder");
    const { ctx: replayCtx } = buildReplayContext({ token_address: `${PREFIX}CONTRACT`, foundation_tier_json: "{}" });
    assert.doesNotThrow(() => assertValidContext(replayCtx, "test-recheck", CURRENT_CONTEXT_SCHEMA));
});
