// services/intelligence/market/momentumPhase.js - FINAL PRODUCTION
// SPRINT P0, entry-quality root cause fix. Real production evidence
// (Diego/Miyako/Bear/FARTATM - several red within seconds of BUY)
// traces to a genuine blind spot: qualityGateService.js's checks
// (rug_ratio/top_10_holder_rate/bundler_mhr/serial-creator pattern) all
// detect STRUCTURAL scam patterns, but say nothing about TIMING - a
// token can be completely "clean" by every one of those checks and
// still be a terrible buy because its pump already happened and it's
// now being distributed onto late buyers. Arjuna's unified entry score
// (researchEngineFactory.js's computeUnifiedEntryScore) also has no
// axis for this - accumulation/smartMoney/holderDistribution/liquidity/
// security/etc. all describe the token's current STATE, never whether
// its price action is a genuine early move, a late/healthy continuation,
// a dead-cat bounce inside an ongoing dump, a recovery attempt long
// after a prior rug, or a pump built to exit insiders into retail.
//
// This module classifies which of those five real phases a token is in,
// using ONLY data already collected elsewhere in this codebase - no new
// fetch, no new field. It NEVER contributes to the unified entry score
// (score/max are always 0 - not present in config.entryScore.weights,
// so computeUnifiedEntryScore's loop skips it entirely; verified by
// this file's own tests) and is NOT a new hard gate (never sets
// action=AVOID, never vetoes) - it feeds the SAME existing riskReasons
// aggregation every other market/participant module already contributes
// to (researchEngineFactory.js's `riskReasons` array -> computeRisk's
// existing HIGH-risk threshold, unchanged this sprint). A token in a
// risky phase gets one more real, honest risk reason recorded and
// visible - exactly the same mechanism developer.js/sniper.js/
// priceStability.js already use - never a second, independent gate.
// The classification itself (phase name + the real facts behind it) is
// always returned, for every token regardless of phase, so it can be
// persisted onto the Decision Snapshot for genuine BUY-reasoning
// observability (Part 4 of this sprint).
//
// PHASES:
//   EARLY_MOMENTUM   - no recorded price history yet, or currently at/
//                       near its own observed peak, moving up. The
//                       "still forming" case Arjuna's DNA is built to
//                       catch - never penalized for lacking a track
//                       record yet.
//   HEALTHY_MOMENTUM - an established move that isn't flagged by any of
//                       the three risk phases below. Default bucket,
//                       contributes nothing.
//   DEAD_BOUNCE      - already fell hard from its own real recorded
//                       peak (>=50%) and the last 5 minutes ticked up
//                       while the last hour is still net negative - a
//                       small wiggle inside an ongoing dump, not a
//                       reversal.
//   POST_RUG_RECOVERY- fell even harder from its own peak (>=70%) but
//                       BOTH the 5m and 1h windows are genuinely
//                       positive - a real recovery attempt long after a
//                       severe prior collapse, not a momentary bounce.
//                       Real, elevated risk (a token that already
//                       rugged once) - flagged, never auto-rejected;
//                       Arjuna stays free to buy it.
//   EXIT_LIQUIDITY    - price is currently rising but real orderflow
//                       doesn't support it: 24h net buy pressure
//                       (trenches' own net_buy_24h) is negative, or the
//                       last 5 minutes shows more real sell volume than
//                       buy volume despite the price tick - the classic
//                       "thin book walked up, then dumped into" shape.
//
// Thresholds below are a first, unvalidated starting point (same
// explicit convention qualityGateService.js's own header already uses
// for its thresholds) - not claimed to be final-calibrated.

const tokenPriceHistoryRepository = require("../../../repositories/tokenPriceHistoryRepository");

const DEAD_BOUNCE_MIN_DRAWDOWN = 0.50;
const POST_RUG_RECOVERY_MIN_DRAWDOWN = 0.70;
const EARLY_MOMENTUM_MAX_DRAWDOWN = 0.15;

function classifyMomentumPhase(token, trenchesEntry){

    const price = token.price != null ? Number(token.price) : null;
    const change5m = token.price_change_5m != null ? Number(token.price_change_5m) : null;
    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;
    const netBuy24h = trenchesEntry?.net_buy_24h != null ? Number(trenchesEntry.net_buy_24h) : null;
    const buys5m = token.buys_5m != null ? Number(token.buys_5m) : null;
    const sells5m = token.sells_5m != null ? Number(token.sells_5m) : null;

    const peak = price != null ? tokenPriceHistoryRepository.findPeakPrice(token.token_address) : null;
    // Real drawdown from this token's own observed peak - null when
    // there's no price history yet (a genuinely new token, or the
    // collector hasn't ticked for it yet) - never treated as "already
    // crashed" just because history is absent.
    const drawdownFromPeak = (peak != null && peak > 0 && price != null) ? Math.max(0, (peak - price) / peak) : null;

    const facts = { price, peak, drawdownFromPeak, change5m, change1h, netBuy24h, buys5m, sells5m };

    // EXIT_LIQUIDITY - checked first: price rising on orderflow that
    // doesn't support it is dangerous regardless of drawdown shape.
    const priceRising = (change5m != null && change5m > 0) || (change1h != null && change1h > 0);
    const netBuyNegative = netBuy24h != null && netBuy24h < 0;
    const sellDominated5m = buys5m != null && sells5m != null && (buys5m + sells5m) > 0 && sells5m > buys5m;
    if(priceRising && (netBuyNegative || sellDominated5m)){
        return {
            phase: "EXIT_LIQUIDITY", facts,
            riskReason: netBuyNegative
                ? `Price rising but 24h net buy pressure is negative ($${Math.round(netBuy24h).toLocaleString()}) - real money is net leaving despite the price tick, a possible exit-liquidity pump`
                : `Price rising but the last 5 minutes shows more real sell volume than buy volume - a possible exit-liquidity pump`
        };
    }

    if(drawdownFromPeak != null){

        if(drawdownFromPeak >= POST_RUG_RECOVERY_MIN_DRAWDOWN && change5m != null && change5m > 0 && change1h != null && change1h > 0){
            return {
                phase: "POST_RUG_RECOVERY", facts,
                riskReason: `Attempting to recover after a severe ${(drawdownFromPeak*100).toFixed(0)}% drawdown from its own observed peak - a real prior collapse, elevated risk even though the current move is genuine`
            };
        }

        if(drawdownFromPeak >= DEAD_BOUNCE_MIN_DRAWDOWN && change5m != null && change5m > 0 && change1h != null && change1h < 0){
            return {
                phase: "DEAD_BOUNCE", facts,
                riskReason: `Down ${(drawdownFromPeak*100).toFixed(0)}% from its own observed peak with the 1h trend still negative - the current uptick looks like a bounce inside an ongoing dump, not a reversal`
            };
        }

        if(drawdownFromPeak <= EARLY_MOMENTUM_MAX_DRAWDOWN){
            return { phase: "EARLY_MOMENTUM", facts, riskReason: null };
        }

    }
    else{
        // No recorded price history yet - never penalized for lacking a
        // track record, exactly Arjuna's own age-is-a-bonus-not-a-gate
        // posture (Part 5, unchanged this sprint).
        return { phase: "EARLY_MOMENTUM", facts, riskReason: null };
    }

    return { phase: "HEALTHY_MOMENTUM", facts, riskReason: null };

}

// Market-module shape (score/max/riskReasons) so this plugs into
// researchEngineFactory.js's existing marketModules object exactly like
// every other module - score/max are ALWAYS 0 (this signal never drives
// the unified entry score or the legacy marketScore blend; see this
// file's header). facts.momentumPhase is threaded through so it can be
// persisted onto the Decision Snapshot even for a HEALTHY_MOMENTUM/
// EARLY_MOMENTUM token with no riskReason.
function score(token, trenchesEntry){

    const classification = classifyMomentumPhase(token, trenchesEntry);

    return {
        score: 0,
        max: 0,
        // Always real, always computed (even a token with no price
        // history yet gets an honest EARLY_MOMENTUM classification, not
        // an absence) - never counted as "missing evidence" the way an
        // actually-absent module (hasData:false) would be.
        hasData: true,
        phase: classification.phase,
        facts: classification.facts,
        riskReasons: classification.riskReason ? [classification.riskReason] : []
    };

}

module.exports = { score, classifyMomentumPhase };
