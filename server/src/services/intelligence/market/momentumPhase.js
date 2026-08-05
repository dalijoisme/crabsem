// services/intelligence/market/momentumPhase.js - entry-quality root
// cause fix (FINAL PRODUCTION SPRINT P0), reworked into a pure SCORING
// MODIFIER per SPRINT 12 (Arjuna V5) CTO DECISION (FINAL). Real
// production evidence (Diego/Miyako/Bear/FARTATM - several red within
// seconds of BUY) traces to a genuine blind spot: qualityGateService.js's
// checks (rug_ratio/top_10_holder_rate/bundler_mhr/serial-creator
// pattern) all detect STRUCTURAL scam patterns, but say nothing about
// TIMING - a token can be completely "clean" by every one of those
// checks and still be a terrible buy because its pump already happened
// and it's now being distributed onto late buyers.
//
// SPRINT 12 CTO DECISION (FINAL): "Momentum TIDAK BOLEH menjadi hard
// gate. Momentum hanya boleh menjadi scoring modifier." The PRIOR turn
// of this same sprint fed a risky phase into researchEngineFactory.js's
// riskReasons array (computeRisk's HIGH-risk aggregation) - explicitly
// REVERSED here, because accumulating enough risky-phase reasons could
// itself push a token to HIGH risk and hard-reject a BUY on momentum
// alone, exactly the shape the CTO forbids. This file now ONLY ever
// returns a phase name and the real facts behind it - it never sets
// riskReasons, never vetoes, never touches action/risk. The CTO's own
// fixed point table (config/scoringConfig.js's entryScore.momentumModifier)
// is added DIRECTLY into computeUnifiedEntryScore's final 0-100 score,
// the exact same additive spot ageBonusPoints/securityPenalty/washPenalty
// already use - a token can still reach BUY (>=68) or fall short of it
// purely from its OTHER real signals; momentum only nudges the number.
//
// PHASES (six, per the CTO's own point table):
//   EARLY_MOMENTUM    - no recorded price history yet, or currently at/
//                       near its own observed peak, moving up. The
//                       "still forming" case Arjuna's DNA is built to
//                       catch - never penalized for lacking a track
//                       record yet.
//   HEALTHY_MOMENTUM  - price is genuinely still rising (a real,
//                       established continuation), not early-stage and
//                       not flagged by any of the three risk phases
//                       below.
//   NORMAL            - no strong signal either way - price flat/
//                       negative but not shaped like a dead bounce or a
//                       post-rug recovery. The true neutral default.
//   DEAD_BOUNCE       - already fell hard from its own real recorded
//                       peak (>=50%) and the last 5 minutes ticked up
//                       while the last hour is still net negative - a
//                       small wiggle inside an ongoing dump, not a
//                       reversal.
//   EXIT_LIQUIDITY    - price is currently rising but real orderflow
//                       doesn't support it: 24h net buy pressure
//                       (trenches' own net_buy_24h) is negative, or the
//                       last 5 minutes shows more real sell volume than
//                       buy volume despite the price tick - the classic
//                       "thin book walked up, then dumped into" shape.
//   POST_RUG_RECOVERY - fell even harder from its own peak (>=70%) but
//                       BOTH the 5m and 1h windows are genuinely
//                       positive - a real recovery attempt long after a
//                       severe prior collapse, not a momentary bounce.
//
// Drawdown thresholds below are a first, unvalidated starting point
// (same explicit convention qualityGateService.js's own header already
// uses for its own thresholds) - not claimed to be final-calibrated.
// The POINT VALUES themselves are the CTO's own fixed decision
// (config/scoringConfig.js), not this file's to choose.

const DEAD_BOUNCE_MIN_DRAWDOWN = 0.50;
const POST_RUG_RECOVERY_MIN_DRAWDOWN = 0.70;
const EARLY_MOMENTUM_MAX_DRAWDOWN = 0.15;

// Sprint 15 (Scientific Decision Framework), Phase 2 - Repository
// Boundary Migration: `peak` is now a required 3rd parameter (this
// token's real historical peak price, ctx.peakPriceByAddress.get(address) -
// see researchEngineFactory.js's preloadContext) instead of this module
// calling tokenPriceHistoryRepository itself. This file no longer reads
// any repository at all - only researchEngineFactory.js's Context
// Builder does, per the Sprint 15 Context Contract.
function classifyMomentumPhase(token, trenchesEntry, rawPeak){

    const price = token.price != null ? Number(token.price) : null;
    const change5m = token.price_change_5m != null ? Number(token.price_change_5m) : null;
    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;
    const netBuy24h = trenchesEntry?.net_buy_24h != null ? Number(trenchesEntry.net_buy_24h) : null;
    const buys5m = token.buys_5m != null ? Number(token.buys_5m) : null;
    const sells5m = token.sells_5m != null ? Number(token.sells_5m) : null;

    // Preserves the original guard exactly: peak was previously never
    // even looked up when price was null - now that the caller always
    // pre-fetches it regardless of price, this keeps that same "never
    // consider a peak without a current price" behavior instead of
    // silently starting to use rawPeak in a case that used to be null.
    const peak = price != null ? rawPeak : null;
    // Real drawdown from this token's own observed peak - null when
    // there's no price history yet (a genuinely new token, or the
    // collector hasn't ticked for it yet) - never treated as "already
    // crashed" just because history is absent.
    const drawdownFromPeak = (peak != null && peak > 0 && price != null) ? Math.max(0, (peak - price) / peak) : null;

    const facts = { price, peak, drawdownFromPeak, change5m, change1h, netBuy24h, buys5m, sells5m };
    const priceRising = (change5m != null && change5m > 0) || (change1h != null && change1h > 0);

    // EXIT_LIQUIDITY - checked first: price rising on orderflow that
    // doesn't support it is dangerous regardless of drawdown shape.
    const netBuyNegative = netBuy24h != null && netBuy24h < 0;
    const sellDominated5m = buys5m != null && sells5m != null && (buys5m + sells5m) > 0 && sells5m > buys5m;
    if(priceRising && (netBuyNegative || sellDominated5m)){
        return { phase: "EXIT_LIQUIDITY", facts };
    }

    if(drawdownFromPeak != null){

        if(drawdownFromPeak >= POST_RUG_RECOVERY_MIN_DRAWDOWN && change5m != null && change5m > 0 && change1h != null && change1h > 0){
            return { phase: "POST_RUG_RECOVERY", facts };
        }

        if(drawdownFromPeak >= DEAD_BOUNCE_MIN_DRAWDOWN && change5m != null && change5m > 0 && change1h != null && change1h < 0){
            return { phase: "DEAD_BOUNCE", facts };
        }

        if(drawdownFromPeak <= EARLY_MOMENTUM_MAX_DRAWDOWN){
            return { phase: "EARLY_MOMENTUM", facts };
        }

    }
    else{
        // No recorded price history yet - never penalized for lacking a
        // track record, exactly Arjuna's own age-is-a-bonus-not-a-gate
        // posture (Part 5, unchanged this sprint).
        return { phase: "EARLY_MOMENTUM", facts };
    }

    // Neither early, nor a risky shape - HEALTHY_MOMENTUM if price is
    // still genuinely rising (a real continuation), NORMAL (true
    // neutral) otherwise.
    return { phase: priceRising ? "HEALTHY_MOMENTUM" : "NORMAL", facts };

}

// Market-module shape (score/max) so this plugs into
// researchEngineFactory.js's existing marketModules object exactly like
// every other module - score/max are ALWAYS 0 (this module never drives
// the unified entry score or the legacy marketScore blend directly; its
// point value is looked up separately via config.entryScore.momentumModifier
// and added into computeUnifiedEntryScore's final score, same additive
// spot as ageBonusPoints - see this file's own header). No riskReasons -
// SPRINT 12's CTO decision is explicit that momentum must never feed the
// HIGH-risk hard-gate aggregation. facts.momentumPhase is threaded
// through so it can be persisted onto the Decision Snapshot regardless
// of phase.
function score(token, trenchesEntry, peak){

    const classification = classifyMomentumPhase(token, trenchesEntry, peak);

    return {
        score: 0,
        max: 0,
        // Always real, always computed (even a token with no price
        // history yet gets an honest EARLY_MOMENTUM classification, not
        // an absence) - never counted as "missing evidence" the way an
        // actually-absent module (hasData:false) would be.
        hasData: true,
        phase: classification.phase,
        facts: classification.facts
    };

}

module.exports = { score, classifyMomentumPhase };
