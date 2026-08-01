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

const db = require("../database/connection");
const productionV2 = require("./productionEngineV2");
const decisionEngineV2 = require("./decisionEngineV2");

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

function applyDecisionEngineV2(baseSignal){
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
            reasoning: result.reasoning
        }
    };
}

function analyzeToken(token, ctx, philosophyOverride){
    const base = productionV2.analyzeToken(token, ctx, philosophyOverride);
    return applyDecisionEngineV2(base);
}

function analyzeTokens(tokens, philosophyOverride){
    return productionV2.analyzeTokens(tokens, philosophyOverride).map(applyDecisionEngineV2);
}

function buildRiskBands(token, signal, exitOverrides){
    return productionV2.buildRiskBands(token, signal, exitOverrides);
}

module.exports = {
    analyzeToken, analyzeTokens, buildRiskBands,
    // Exported for observability/testing only - not called by any
    // trading-logic file.
    getHistoricalIndex, _resetCacheForTests
};
