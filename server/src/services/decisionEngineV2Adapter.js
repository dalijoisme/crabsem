// services/decisionEngineV2Adapter.js - Decision Engine V2 Integration
// Sprint. The wiring point between the EXISTING engine-version-registry
// mechanism (services/productionEngineResolver.js's own header comment:
// "the ONLY place that decides which engine actually drives real
// predictions") and services/decisionEngineV2.js's 5-layer historical
// adjustment. Registered as a new ENGINES entry there - see that file
// and config/productionVersionRegistry.js for the actual activation
// switch. No Scheduler/TradeManager/Executor file is touched by this
// integration - this adapter is consumed through the exact same
// indirection point productionV1/productionV2 already go through.
//
// Layer 1 is untouched (per Decision Engine V2's own design): this file
// wraps productionEngineV2 (Momentum Hunter, the current ACTIVE engine)
// byte-identically - every field it already computes (participantScore,
// marketHealth, breakdown, riskReasons, selfValidation, acceleration,
// reasons, ...) passes through unmodified via spread. ONLY action/
// confidence are ever overridden, and only by decisionEngineV2.evaluateV2()'s
// own Layer 2-5 - this file adds no scoring logic of its own.
//
// buildRiskBands is a PURE passthrough to productionV2.buildRiskBands -
// Decision Engine V2 never touches TP/SL.
//
// Decision Trace / Explain Mode sprint: logExplainTrace() below is the
// ONLY addition in this sprint, and it is read-only by construction - it
// runs strictly AFTER decisionEngineV2.evaluateV2() has already produced
// the final action/confidence, and only ever calls console.log with data
// already computed. It cannot change a decision because it never runs
// before one is made and never feeds anything back into applyDecisionEngineV2's
// own return value's action/confidence (those are set from `result`
// exactly as before this sprint). Off by default
// (config.DECISION_ENGINE_V2_EXPLAIN, env DECISION_ENGINE_V2_EXPLAIN) -
// zero output, zero overhead beyond one boolean check, unless
// deliberately enabled for an audit session. Logs only BUY/STRONG BUY
// -tier base candidates (the ones this sprint's own diagnostic question -
// "why is nothing passing?" - is actually about); HOLD/AVOID-tier
// candidates are never touched by Layer 5's override logic anyway (see
// decide()'s own "never upgrades" guarantee).

const db = require("../database/connection");
const envConfig = require("../config/env");
const productionV2 = require("./productionEngineV2");
const decisionEngineV2 = require("./decisionEngineV2");

// explainEnabled defaults to the real central config - production
// callers never pass the third argument, so behavior is always driven
// by config/env.js's DECISION_ENGINE_V2_EXPLAIN exactly as documented.
// The parameter exists so this exact function (not a copy) can be unit-
// tested for both branches without needing to mutate the frozen env
// config singleton.
function logExplainTrace(token, result, explainEnabled = envConfig.DECISION_ENGINE_V2_EXPLAIN){
    if(!explainEnabled) return;
    if(result.baseAction !== "BUY" && result.baseAction !== "STRONG BUY") return;
    const label = token?.symbol || token?.token_address || "(unknown token)";
    console.log(`[decision-engine-v2-explain] ${label}`, JSON.stringify(result.trace, null, 2));
}

// Historical index cache: rebuilt at most once per REFRESH_MS, never on
// every single analyzeToken(s) call - trading_bot_trades/positions don't
// change fast enough within one scan cycle to justify a fresh SQL
// aggregate on every call, and analyzeTokens() is already invoked once
// per tick per distinct Strategy Profile philosophy (same "compute once"
// principle scheduler/tradingBotScheduler.js's own header comment
// already establishes for its own per-tick work - this file applies it
// to its own extra read instead of duplicating that principle).
//
// GLOBAL, not per-user: analyzeTokens() itself has no user context (it's
// computed once and fanned out to every due user - see
// tradingBotScheduler.js's own header comment on why) - Decision Engine
// V2's historical index is therefore built from every user's real closed
// trades combined, not scoped to one account. Documented explicitly here
// rather than left as an unstated assumption.
const REFRESH_MS = 5 * 60 * 1000;
let cachedIndex = null;
let cachedAt = 0;

function getHistoricalIndex(){
    const now = Date.now();
    if(cachedIndex && (now - cachedAt) < REFRESH_MS) return cachedIndex;
    const trades = decisionEngineV2.loadHistoricalTrades(db, {});
    cachedIndex = decisionEngineV2.buildHistoricalStatsIndex(trades);
    cachedAt = now;
    return cachedIndex;
}

// Test-only: forces the next getHistoricalIndex() call to rebuild rather
// than reuse a cache that may have been populated by an earlier test.
function _resetCacheForTests(){
    cachedIndex = null;
    cachedAt = 0;
}

function applyDecisionEngineV2(baseSignal, token){
    const historicalIndex = getHistoricalIndex();
    const result = decisionEngineV2.evaluateV2(
        {
            action: baseSignal.action,
            confidence: baseSignal.confidence,
            risk: baseSignal.risk,
            reasons: baseSignal.reasons,
            riskReasons: baseSignal.riskReasons
        },
        historicalIndex
    );

    logExplainTrace(token, result);

    return {
        ...baseSignal,
        action: result.action,
        confidence: result.confidence,
        // Additive, namespaced field - every existing reader of a signal
        // object (tradingBotScheduler.js's liveMap construction,
        // tradeManager.js's breakdown_json) keeps reading the same
        // action/confidence/reasons/breakdown fields it always has;
        // nothing downstream needs to change to keep working.
        decisionEngineV2: {
            baseAction: result.baseAction,
            baseConfidence: result.baseConfidence,
            historical: result.historical,
            sampleConfidenceFactor: result.sampleConfidenceFactor,
            fallbackToBaseScoring: result.fallbackToBaseScoring,
            reasoning: result.reasoning,
            // Decision Trace / Explain Mode sprint - same data
            // logExplainTrace prints, also available to any direct
            // caller of analyzeToken(s) (e.g. entryGateService's
            // reentry-scrutiny check) without needing the env flag on.
            trace: result.trace
        }
    };
}

// Root-cause diagnosis sprint (Qualified BUY = 0): UNCONDITIONAL - does
// NOT depend on config.DECISION_ENGINE_V2_EXPLAIN (that flag's own
// worker_thread env-propagation is exactly one of the things under
// suspicion, so this trace must not depend on it to be trustworthy).
// Runs BEFORE applyDecisionEngineV2()/evaluateV2() - describes the base
// engine's OWN raw output, never anything Decision Engine V2 touched.
// Read-only: only console.log/console.error calls, every try/catch
// rethrows the exact original error unchanged - control flow and the
// final return value are byte-identical to before this instrumentation.
function tallyByAction(signals){
    const counts = {};
    for(const s of signals){
        const key = s?.action || "(no action field)";
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

function labelFor(token, index){
    return token?.symbol || token?.token_address || `(candidate #${index}, no token identity)`;
}

// AVOID is deliberately excluded from the per-candidate lines (it is
// always the large majority - see prior "Filtering:" log evidence - and
// is never diagnostically relevant to "why isn't BUY passing"); the
// aggregate actionBreakdown count above still includes it, so nothing
// about its true volume is hidden.
function logPreV2Trace(tokens, baseSignals){
    console.log(`[decision-engine-v2-pretrace] candidatesSentToV2=${tokens.length} baseSignalsReturned=${baseSignals.length} actionBreakdown=${JSON.stringify(tallyByAction(baseSignals))}`);
    if(baseSignals.length !== tokens.length){
        console.error(`[decision-engine-v2-pretrace] MISMATCH: productionV2.analyzeTokens returned ${baseSignals.length} signals for ${tokens.length} input tokens - base engine (Layer 1) silently dropped ${tokens.length - baseSignals.length} candidate(s) BEFORE Decision Engine V2 ever saw them.`);
    }
    for(let i = 0; i < baseSignals.length; i++){
        const signal = baseSignals[i];
        if(signal?.action === "AVOID") continue;
        console.log(`[decision-engine-v2-pretrace] token=${labelFor(tokens[i], i)} baseAction=${signal?.action ?? "(none)"} baseConfidence=${signal?.confidence ?? "(none)"} evaluateV2WillBeCalled=true`);
    }
}

function analyzeToken(token, ctx, philosophyOverride){
    let base;
    try{
        base = productionV2.analyzeToken(token, ctx, philosophyOverride);
    }
    catch(err){
        console.error(`[decision-engine-v2-pretrace] productionV2.analyzeToken THREW for token=${labelFor(token, 0)} - Decision Engine V2 was NEVER reached: ${err.message}`, err.stack);
        throw err;
    }
    console.log(`[decision-engine-v2-pretrace] token=${labelFor(token, 0)} baseAction=${base?.action ?? "(none)"} baseConfidence=${base?.confidence ?? "(none)"} evaluateV2WillBeCalled=true`);
    try{
        return applyDecisionEngineV2(base, token);
    }
    catch(err){
        console.error(`[decision-engine-v2-pretrace] applyDecisionEngineV2/evaluateV2 THREW for token=${labelFor(token, 0)}: ${err.message}`, err.stack);
        throw err;
    }
}

function analyzeTokens(tokens, philosophyOverride){
    let baseSignals;
    try{
        baseSignals = productionV2.analyzeTokens(tokens, philosophyOverride);
    }
    catch(err){
        console.error(`[decision-engine-v2-pretrace] productionV2.analyzeTokens THREW for a batch of ${tokens.length} tokens - Decision Engine V2 was NEVER reached for ANY of them: ${err.message}`, err.stack);
        throw err;
    }

    logPreV2Trace(tokens, baseSignals);

    try{
        return baseSignals.map((signal, i) => applyDecisionEngineV2(signal, tokens[i]));
    }
    catch(err){
        console.error(`[decision-engine-v2-pretrace] applyDecisionEngineV2/evaluateV2 THREW while processing a batch of ${baseSignals.length} base signals: ${err.message}`, err.stack);
        throw err;
    }
}

function buildRiskBands(token, signal, exitOverrides){
    return productionV2.buildRiskBands(token, signal, exitOverrides);
}

module.exports = {
    analyzeToken, analyzeTokens, buildRiskBands,
    // Exported for observability/testing only - not called by any
    // trading-logic file.
    getHistoricalIndex, _resetCacheForTests, logExplainTrace
};
