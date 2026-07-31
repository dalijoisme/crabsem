// services/dynamicExitService.js - Dynamic Take-Profit exit rule,
// approved for real Trading Bot adoption (Decision Benchmark request -
// "bukan dibuat khusus hanya untuk benchmark"). TP15 becomes a MINIMUM
// target, not a hard stop: once a position's ROI reaches +15%, it
// keeps running as long as real, already-collected momentum evidence
// still supports it. Exit fires the moment that evidence weakens -
// never a guessed "let it ride" with no real basis, and never a fixed
// ceiling either.
//
// Used IDENTICALLY by both benchmark profiles (Regular and the
// Momentum Hunter tournament replica) - per the benchmark's own
// requirement that exit logic must not differ between the two entry
// methodologies being compared. Every input is a real, already-
// collected field - nothing new is fetched from GMGN for this.
//
// Does NOT import or modify intelligenceEngine.js, researchEngineFactory.js,
// or productionEngineV2.js - Production V2 and Momentum Hunter are
// completely untouched, per instruction. The "reversal/distribution"
// checks below are an independent, honestly-labeled re-derivation
// using the SAME real fields and the SAME scoringConfig.js thresholds
// those engines already use internally - not a copy of their code, a
// parallel real-data check built to avoid touching engine files at all.

const scoringConfig = require("../config/scoringConfig");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");

const MIN_TP_PCT = 15;

// Real evidence of reversal/distribution, reusing scoringConfig.js's
// own structuralValidation thresholds (unmodified, shared, not copied
// logic) - never a fabricated cutoff.
function hasReversalOrDistributionSigns(token, trenchesEntry){

    const sv = scoringConfig.structuralValidation;

    const change5m = token.price_change_5m != null ? Number(token.price_change_5m) : null;
    if(change5m != null && change5m <= sv.recentDump5mPct) return true; // a real dump in progress right now

    const peak = tokenPriceHistoryRepository.findPeakPrice(token.token_address);
    const price = token.price != null ? Number(token.price) : null;
    if(peak != null && peak > 0 && price != null){
        const drawdown = (peak - price) / peak;
        if(drawdown >= sv.structuralBreakdownDrawdown) return true; // real structural breakdown from the highest price ever observed
    }

    const netBuy24h = trenchesEntry?.net_buy_24h != null ? Number(trenchesEntry.net_buy_24h) : null;
    if(netBuy24h != null && netBuy24h <= sv.netDistributionUsd) return true; // real net distribution, not accumulation

    return false;

}

// ratio (Strategy Profile refactor, optional, trailing, default 0.5 -
// today's hardcoded value): how much of 24h buy/sell flow must be
// buy-side for momentum to still count as "buyer-led." This is the
// practical "how patient is the trailing hold" knob, since no separate
// trailing-stop mechanism exists in this codebase.
function buyerDominant(trenchesEntry, ratio = 0.5){

    if(!trenchesEntry) return null; // no real data - never guessed

    const buys = Number(trenchesEntry.buys_24h) || 0;
    const sells = Number(trenchesEntry.sells_24h) || 0;

    if(buys + sells === 0) return null;

    return (buys / (buys + sells)) > ratio;

}

// engineAction: a FRESH action from calling the active engine directly
// (productionEngineResolver.getActiveEngine().analyzeToken()) - both
// benchmark profiles resolve to the same Momentum Hunter engine here,
// so this reversal check is identical for both by construction, not
// by convention.
//
// minTpPct/buyerDominanceRatio (Strategy Profile refactor, optional,
// trailing, default MIN_TP_PCT/0.5 - today's hardcoded values): lets a
// profile's own exit overrides (fixedTpPct, momentumWeakeningBuyerDominanceRatio)
// govern this check too, instead of the two hardcoded "15"s in this
// file and productionEngineV2.js silently drifting apart per-profile.
//
// Returns { shouldClose, reason, currentPrice, roiPct }.
function evaluateDynamicExit({ position, token, trenchesEntry, engineAction, stopLossPrice, minTpPct = MIN_TP_PCT, buyerDominanceRatio = 0.5 }){

    const currentPrice = Number(token.price) || position.current_price || position.entry_price;
    const roiPct = ((currentPrice / position.entry_price) - 1) * 100;

    // 1. Reversal - the engine's own fresh signal explicitly says AVOID
    //    right now. Checked first, overrides everything, any ROI level.
    if(engineAction === "AVOID"){
        return { shouldClose: true, reason: "REVERSAL", currentPrice, roiPct };
    }

    // 2. Stop loss - native dynamic SL, unchanged mechanism, unchanged
    //    threshold (computed once at entry from tradePlanService).
    if(stopLossPrice != null && currentPrice <= stopLossPrice){
        return { shouldClose: true, reason: "STOP_LOSS", currentPrice, roiPct };
    }

    // 3. Below the minimum target - nothing else to evaluate yet,
    //    keep running.
    if(roiPct < minTpPct){
        return { shouldClose: false, currentPrice, roiPct };
    }

    // 4. At/above the minimum target - hold ONLY while real momentum
    //    still supports it. ALL four must hold; any single failure
    //    exits immediately (momentum has to be simultaneously strong,
    //    buyer-led, still building, and free of reversal signs - not
    //    "mostly fine").
    //
    // Production Stabilization Final, Section B: `token.marketContextStale`
    // (tradingBotEngine.js's refreshStaleHeldToken) means price/liquidity
    // were just re-verified as real and fresh, but price_change_5m/
    // volume_1h/trenches were NOT - they are whatever was last known,
    // possibly hours old, for a token that has fallen out of the trending
    // scan entirely. Evidence this stale must never be read as "momentum
    // still supports holding" - the same "unknown must not score as good
    // evidence" principle already applied to BUY-side scoring this
    // engagement, now applied to the exit side. This never touches the
    // Stop Loss check above (already always fresh) or the sub-minTpPct
    // "keep running" branch (position is not yet in profit-protection
    // territory) - only the optional "ride the winner further" decision.
    const contextStale = Boolean(token.marketContextStale);

    const change5m = token.price_change_5m != null ? Number(token.price_change_5m) : null;
    const momentumStillPositive = !contextStale && change5m != null ? change5m > 0 : false;

    const dominant = buyerDominant(trenchesEntry, buyerDominanceRatio);
    const buyersInControl = !contextStale && dominant === true;

    const currentVolume1h = token.volume_1h != null ? Number(token.volume_1h) : null;
    const volumeStillBuilding = contextStale
        ? false // stale market context - never assume volume is still building
        : (position.last_volume_1h == null || currentVolume1h == null
            ? true // no prior reading to compare against yet - don't penalize on absence of data
            : currentVolume1h >= position.last_volume_1h);

    const noReversalSigns = !hasReversalOrDistributionSigns(token, trenchesEntry);

    const momentumSustained = momentumStillPositive && buyersInControl && volumeStillBuilding && noReversalSigns;

    if(!momentumSustained){
        return { shouldClose: true, reason: contextStale ? "MOMENTUM_WEAKENING_STALE_CONTEXT" : "MOMENTUM_WEAKENING", currentPrice, roiPct };
    }

    return { shouldClose: false, currentPrice, roiPct };

}

module.exports = { evaluateDynamicExit, MIN_TP_PCT };
