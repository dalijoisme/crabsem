// services/replayContextBuilder.js - Sprint 15 (Scientific Decision
// Framework), Phase 6. The SECOND, independent Context Builder -
// researchEngineFactory.js's preloadContext(tokens) is the LIVE one,
// this is REPLAY's. Both must satisfy the exact same Context Contract
// (contextContract.js) and produce the exact same shape, so the real
// production scoring functions (analyzeTokenWithPhilosophy and
// everything it calls) execute completely unchanged in either mode -
// this file's entire job is reconstructing ctx from a stored Decision
// Evidence record, never touching a live repository, ever.
//
// REPLAY PURITY (approved Sprint 15 architecture): this file never
// calls a repository, never calls collector code, never calls
// orchestration functions (entryGateService.evaluateEntry,
// tradingBotEngine.runCycle, etc). It only reads the already-captured
// Foundation Tier JSON a real BUY's decision_evidence row already holds.
//
// FIDELITY IS BOUNDED BY WHAT WAS CAPTURED, NOT HIDDEN: a record whose
// foundation_tier_completeness is PARTIAL_FOUNDATION (every real record
// today, until the Phase 3 gap this file's own header names is closed)
// produces a ctx with real data in trenchesByAddress/peakPriceByAddress/
// realtimePulseByAddress, and deliberately EMPTY (not fabricated) Maps
// for smartMoneyByAddress/kolByAddress/cacheMap/walletsByAddress/
// hotSearchByAddress/launchpadStatsByName/liquidityAtWindowStartByAddress -
// an empty container is a contract-valid ctx (Context Contract rule 4),
// never a reason to throw, but it does mean a replayed score for that
// token will differ from the original wherever the original genuinely
// used smart-money/KOL/wallet-quality evidence. Callers that need to
// know this can read the completeness/missingRawSources this function
// also returns, rather than re-deriving it from the JSON themselves.

const { assertValidContext, CURRENT_CONTEXT_SCHEMA } = require("./contextContract");
// Imported for TRACKED_SIGNALS ONLY - a static, importable list of signal
// names (no function call, no I/O, no live buffer access). This file
// must NEVER call realtimePulseService.getLatestSignals/computeTokenSignals
// itself: during replay, the live in-memory buffer for a token being
// replayed could easily hold TODAY's real state (if that token is still
// actively trending in whatever process replay happens to run inside),
// which would silently substitute live current data for the frozen
// historical snapshot replay exists to guarantee. The degenerate default
// below is a static, offline-safe stand-in for "no real pulse data was
// captured for this decision", built independently of any live call.
const { TRACKED_SIGNALS } = require("./realtimePulseService");

function safeParse(json){
    if(!json) return null;
    try{ return JSON.parse(json); }
    catch(e){ return null; } // malformed/legacy row - never fabricate a shape that was never really captured
}

// The same real "nothing recorded yet" shape realtimePulseService's own
// computeSeriesSignal produces for a buffer with fewer than 2 points -
// duplicated here as a static constant (see the header above for why
// this file cannot call the live function itself) rather than a second,
// independent guess at the shape.
function degenerateRealtimePulse(tokenAddress){
    const signals = {};
    for(const name of Object.keys(TRACKED_SIGNALS)){
        signals[name] = { velocity: null, direction: null, acceleration: null, consistency: null, intervalSecondsUsed: null, stale: null };
    }
    return { tokenAddress, bufferLength: 0, signals, flowDirectionVoteProvisional: null, consistencyVoteProvisional: null, computedAtMs: Date.now() };
}

// decisionEvidenceRecord: a real row as returned by
// decisionEvidenceRepository.findById/findByPositionId (raw DB shape,
// JSON columns still as strings) - this function does the parsing, never
// expects an already-parsed caller.
//
// Returns { ctx, foundationTierCompleteness, missingRawSources } - ctx is
// what gets passed to the real scoring functions; the other two fields
// are the SAME real values already computed once at capture time
// (decisionEvidenceService.js), read back rather than recomputed here.
function buildReplayContext(decisionEvidenceRecord){

    const foundation = safeParse(decisionEvidenceRecord?.foundation_tier_json) || {};
    const address = decisionEvidenceRecord?.token_address;

    const trenchesByAddress = new Map();
    if(address && foundation.trenches != null) trenchesByAddress.set(address, foundation.trenches);

    const peakPriceByAddress = new Map();
    if(address && foundation.peak != null) peakPriceByAddress.set(address, foundation.peak);

    // Unlike trenchesByAddress/peakPriceByAddress (genuinely sparse by
    // nature - the real modules that read them already handle a missing
    // entry via `!= null`/optional-chaining checks), analyzeTokenWithPhilosophy
    // reads ctx.realtimePulseByAddress.get(address).signals.* directly, no
    // guard - because preloadContext() ALWAYS populates one real entry per
    // input token, live. Replay must guarantee the exact same "always
    // present" invariant, or the real scoring function throws on any
    // token whose realtime pulse genuinely wasn't captured - a real crash
    // this exact test file caught before it could reach production.
    const realtimePulseByAddress = new Map();
    if(address) realtimePulseByAddress.set(address, foundation.realtimePulse ?? degenerateRealtimePulse(address));

    // Genuinely not yet captured by Phase 3 (see this file's own header) -
    // empty, real, contract-valid containers, never fabricated content.
    const ctx = {
        trenchesByAddress,
        hotSearchByAddress: new Map(),
        smartMoneyByAddress: new Map(),
        kolByAddress: new Map(),
        cacheMap: new Map(),
        walletsByAddress: new Map(),
        launchpadStatsByName: new Map(),
        peakPriceByAddress,
        liquidityAtWindowStartByAddress: new Map(),
        realtimePulseByAddress
    };

    assertValidContext(ctx, "buildReplayContext", CURRENT_CONTEXT_SCHEMA, {
        engineVersion: decisionEvidenceRecord?.engine_version ?? undefined
    });

    return {
        ctx,
        // The real, verbatim token row captured at decision time (see
        // decisionEvidenceService.buildFoundationTier) - Phase 7 (Replay
        // Engine) needs this alongside ctx to call the real scoring
        // functions, which take (token, ctx, philosophy), never ctx alone.
        token: foundation.token ?? null,
        foundationTierCompleteness: decisionEvidenceRecord?.foundation_tier_completeness ?? null,
        missingRawSources: foundation._missingRawSources ?? null
    };

}

module.exports = { buildReplayContext };
