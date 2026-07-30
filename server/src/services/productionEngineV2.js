// services/productionEngineV2.js - PRODUCTION_V2 candidate engine.
//
// Engine philosophy: Momentum Hunter (server/src/services/researchEngineFactory.js,
// key "momentumHunter") - production's own earliness discount removed entirely, so
// a token that has already moved is scored on the same basis as one that hasn't.
//
// Exit strategy: Fixed Take Profit 15%, native dynamic Stop Loss retained (unchanged
// from tradePlanService.js's real formula).
//
// This exact Engine + Exit combination is the one validated by:
//   - The Engine League tournament (6 hours, 24 philosophies x 8 exits, 192 shadow
//     portfolios) - see server/research-archive/ for that run's data.
//   - The Real Capital Validation Tournament (1 hour, cash-constrained, 1%/1% fees,
//     no leverage) - see server/research-archive/validation-tournament-v2/ (permanent,
//     archived, not deleted).
//
// Drop-in replacement for intelligenceEngine.js: same analyzeToken(token, ctx) /
// analyzeTokens(tokens) contract, PLUS its own buildRiskBands(token, signal) so the
// prediction-creation pipeline (predictionValidationService.js) can ask this engine
// for both a signal AND a matched trade plan through one object (see
// productionEngineResolver.js). Production_V1 (intelligenceEngine.js) is completely
// untouched - this is a new, separate file.

const factory = require("./researchEngineFactory");
const tradePlanService = require("./tradePlanService");

const engines = factory.buildEngines();
const momentumHunter = engines.find(e => e.key === "momentumHunter");

if(!momentumHunter){
    throw new Error("productionEngineV2: 'momentumHunter' philosophy not found in researchEngineFactory.js - check PHILOSOPHIES list.");
}

const FIXED_TP_PCT = 15;

// philosophyOverride (Strategy Profile refactor, optional, trailing):
// when omitted, behavior is byte-identical to before this parameter
// existed - always the static momentumHunter philosophy. When present,
// scoring is delegated to researchEngineFactory.analyzeTokensWithOverride,
// which merges the override onto momentumHunter's own definition (see
// that function for the merge rules). Production V2 itself stays ONE
// implementation either way - this is a parameterized call, not a
// second engine.
function analyzeToken(token, ctx, philosophyOverride){
    const localCtx = ctx || factory.preloadContext([token]);
    if(!philosophyOverride) return momentumHunter.analyzeTokens([token], localCtx)[0];
    return factory.analyzeTokensWithOverride([token], localCtx, "momentumHunter", philosophyOverride)[0];
}

function analyzeTokens(tokens, philosophyOverride){
    if(!tokens.length) return [];
    const ctx = factory.preloadContext(tokens);
    if(!philosophyOverride) return momentumHunter.analyzeTokens(tokens, ctx);
    return factory.analyzeTokensWithOverride(tokens, ctx, "momentumHunter", philosophyOverride);
}

// Fixed TP 15% by default, native dynamic SL (identical formula/inputs to production's
// real tradePlanService.buildRiskBands - only the target is overridden). tradePlanService.js
// itself is not modified; this just re-derives the target price/MC from the same
// price-ratio convention it already uses.
//
// exitOverrides (Strategy Profile refactor, optional, trailing):
// { fixedTpPct, stopLoss: {baseStopPct, highRiskStopPct, maxStopPct} }.
// Omitted/absent fields fall back to this file's own FIXED_TP_PCT and
// tradePlanConfig.js's native stop-loss formula exactly as before.
function buildRiskBands(token, signal, exitOverrides){
    const native = tradePlanService.buildRiskBands(token, signal, exitOverrides?.stopLoss);
    if(!native) return null;

    const currentMc = Number(token.market_cap) || null;
    const currentPrice = Number(token.price) || null;
    if(currentMc == null || currentMc <= 0) return null;

    const tpPct = exitOverrides?.fixedTpPct ?? FIXED_TP_PCT;
    const priceRatio = (currentPrice != null && currentPrice > 0) ? currentPrice / currentMc : null;
    const targetMc = currentMc * (1 + tpPct / 100);

    return {
        entryZone: native.entryZone,
        target: {
            marketCap: targetMc,
            price: priceRatio != null ? targetMc * priceRatio : null,
            expectedMovePct: tpPct,
            trendDiscounted: false
        },
        stopLoss: native.stopLoss,
        inputs: native.inputs
    };
}

module.exports = {
    analyzeToken, analyzeTokens, buildRiskBands,
    PARTICIPANT_MAX: factory.PARTICIPANT_MAX, MARKET_MAX: factory.MARKET_MAX,
    ENGINE_PHILOSOPHY: "momentumHunter", EXIT_STRATEGY: "fixedTP15", FIXED_TP_PCT
};
