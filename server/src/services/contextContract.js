// services/contextContract.js - Sprint 15 (Scientific Decision
// Framework), Phase 1. The single, explicit definition of the Context
// Contract every Decision Pipeline component (Research Engine, Entry
// Gate, Quality Gate, Opportunity Priority, and any future decision
// component) depends on, and every Context Builder (LIVE:
// researchEngineFactory.preloadContext; REPLAY: a future
// buildReplayContext) must satisfy.
//
// PHASE 1 SCOPE: schema + validation + the builder interface contract,
// defined and tested in isolation. Nothing in this file is called from
// the live pipeline yet - preloadContext() is unchanged, and no
// existing behavior changes. Wiring this into the real pipeline
// (moving repository reads out of scoring/entryGate/qualityGate/
// opportunityPriority and validating on the way in) is Phase 2.
//
// THE CONTRACT (approved Sprint 15 architecture):
//   1. No component inside the Decision Pipeline may read a repository
//      directly - only Context Builders may. Everything downstream
//      consumes ctx only.
//   2. A Context Builder must always construct every container listed
//      below, whether or not any individual entry inside it has real
//      data.
//   3. A missing top-level container is a contract violation and must
//      fail loudly (assertValidContext throws, naming the container).
//   4. A missing or empty ENTRY inside a valid container (e.g. a token
//      with no trenches row) is normal business data, never a contract
//      violation - assertValidContext never inspects entries, only
//      container presence.
//   5. Context Builders call assertValidContext on their own output
//      before returning it. The Decision Pipeline calls it again on
//      whatever ctx it receives, before any component runs - two
//      independent checks catching two different failure classes (a
//      broken builder vs. a broken hand-off), not the same check done
//      twice for no reason.
//   6. LIVE and REPLAY differ ONLY in which Context Builder produced
//      ctx - every component downstream of the Context Builder runs
//      identical code in both modes.

// Exactly what researchEngineFactory.js's preloadContext(tokens) returns
// today - verified against its real source, not assumed. Two of these
// (hotSearchByAddress, launchpadStatsByName) are fetched by
// preloadContext but not currently read by analyzeTokenWithPhilosophy or
// anything else in that file - a real, pre-existing observation, left
// alone (no behavior change) and still worth revisiting once the
// remaining PLANNED_CONTEXT_ADDITIONS below are folded in, not decided
// here.
//
// peakPriceByAddress/liquidityAtWindowStartByAddress/realtimePulseByAddress
// (Sprint 15, Phase 2): added when preloadContext was extended to
// pre-fetch these itself, replacing direct calls previously made inside
// computeStructuralRedFlags, momentumPhase.js's classifyMomentumPhase,
// computeAccelerationSignal, and analyzeTokenWithPhilosophy - see
// researchEngineFactory.js's own Phase 2 comments for exactly which call
// site each one replaced.
const CURRENT_CONTEXT_SCHEMA = [
    "trenchesByAddress",
    "hotSearchByAddress",
    "smartMoneyByAddress",
    "kolByAddress",
    "cacheMap",
    "walletsByAddress",
    "launchpadStatsByName",
    "peakPriceByAddress",
    "liquidityAtWindowStartByAddress",
    "realtimePulseByAddress"
];

// PLANNED, not yet in CURRENT_CONTEXT_SCHEMA and not yet enforced.
// Deliberately deferred out of Phase 2's first pass (see the Phase 2
// self-review for why): openPositionStateByUser/lastTradeByToken need
// new BATCH repository methods that don't exist yet and touch the
// Benchmark Harness's own parallel `repository` contract
// (benchmarkPositionRepository.forParticipant); the shared trenches
// value has THREE real callers to reconcile
// (entryGateService.evaluateEntry's MISSING_QUALITY_DATA check,
// qualityGateService.passesQualityGate, and qualityGateService's own
// third caller tokenQueryService.js - which sits OUTSIDE the Decision
// Pipeline entirely, homepage/trending display, not a BUY decision);
// predictionHistoryByToken is opportunityPriorityService.fetchBatchContext's
// own repository read, coupled to the same qualityGateService rework
// since both currently live inside/alongside entryGateService's own
// per-candidate loop.
const PLANNED_CONTEXT_ADDITIONS = [
    "openPositionStateByUser",
    "lastTradeByToken",
    "predictionHistoryByToken"
];

// Bumped any time CURRENT_CONTEXT_SCHEMA's required container list
// changes (a container added, removed, or renamed) - never for anything
// else. Its real job starts in Phase 3 (Decision Evidence): every
// captured decision records the schema version its ctx was validated
// against at that moment, so a record captured under an older required-
// container list stays honestly interpretable later, instead of being
// silently checked against whatever CURRENT_CONTEXT_SCHEMA happens to
// require by the time someone replays it.
//
// v1 (Phase 1): the 7 containers preloadContext already produced.
// v2 (Phase 2): + peakPriceByAddress, liquidityAtWindowStartByAddress,
// realtimePulseByAddress.
const CONTEXT_SCHEMA_VERSION = 2;

// Rules 3/4 above, made concrete: only checks that every required
// container KEY exists and is not null/undefined on ctx. Never inspects
// what's inside a container - a container present but empty (new Map(),
// no entries) is a fully valid, contract-satisfying ctx, exactly as
// common as a token with no trenches row already is today.
//
// meta (optional, trailing): { engineVersion } - included in the thrown
// error whenever a caller has it available, so a violation is traceable
// to which engine's context-building path produced it without anyone
// having to cross-reference logs by timestamp. Omitted/absent is fine -
// every existing caller that doesn't pass a 4th argument is unaffected.
function assertValidContext(ctx, sourceName, requiredContainers = CURRENT_CONTEXT_SCHEMA, meta = {}){

    const label = sourceName || "unknown source";
    const engineVersionPart = meta.engineVersion ? `, engineVersion=${meta.engineVersion}` : "";
    const identity = `source=${label}, contextSchemaVersion=${CONTEXT_SCHEMA_VERSION}${engineVersionPart}`;

    if(!ctx || typeof ctx !== "object"){
        throw new Error(`CONTEXT_CONTRACT_VIOLATION: no context object at all (${identity})`);
    }

    const missing = requiredContainers.filter(key => ctx[key] == null);

    if(missing.length){
        throw new Error(`CONTEXT_CONTRACT_VIOLATION: missing required container(s): ${missing.join(", ")} (${identity})`);
    }

    return ctx;

}

// The Context Builder interface - documented as a duck-typed contract,
// not a class, matching this codebase's existing convention for such
// things (e.g. entryGateService.js's own `repository` parameter: "any
// object implementing findOpenPositionForToken/findLastTradeForToken").
//
// A Context Builder is any function `(input) => ctx` whose returned ctx
// satisfies assertValidContext against CURRENT_CONTEXT_SCHEMA (or its
// Phase 2+ superset), and which calls assertValidContext on its own
// output before returning it (rule 5) - never relying on a caller to
// catch a broken builder.
//
// Today's only real builder: researchEngineFactory.preloadContext(tokens).
// Phase 6 (Replay Context Builder) adds a second, independent builder,
// buildReplayContext(decisionEvidence), producing the identical shape
// from stored Decision Evidence instead of live repositories - the only
// place LIVE and REPLAY are allowed to differ.

module.exports = { CURRENT_CONTEXT_SCHEMA, PLANNED_CONTEXT_ADDITIONS, CONTEXT_SCHEMA_VERSION, assertValidContext };
