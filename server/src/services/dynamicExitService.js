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
// Arjuna vNext sprint, Priority 2/3 (Exit Intelligence / Profit
// Protection). momentumHealthConfig.js owns every tunable number below.
// syntheticMarketFilterService's computeSyntheticBreakdown is reused
// (not re-implemented) for the "orderflow integrity" component - the
// SAME real bot/bundler/wash-pattern signal Priority 1 vetoes a BUY on,
// now read as a continuous health input for an already-OPEN position.
const momentumHealthConfig = require("../config/momentumHealthConfig");
const syntheticMarketFilterService = require("./syntheticMarketFilterService");

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

function clamp0100(n){
    if(!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
}

// "Is the 5m move keeping pace with the 1h trend, or fading" - the
// closest real, already-collected proxy for acceleration without a
// persisted price-history series. change1h > 0 sets an expected 5m
// share (5/60 of the hour's move if momentum were steady); the real 5m
// reading is compared against that expectation, not against a fixed
// number. change1h <= 0 (no established uptrend to accelerate FROM)
// falls back to change5m's own sign, since there is nothing steady to
// measure deceleration against.
function priceAccelerationScore(token){
    const change5m = token.price_change_5m != null ? Number(token.price_change_5m) : null;
    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;
    if(change5m == null) return null;
    if(change1h != null && change1h > 0){
        const expected5mShare = change1h * (5 / 60);
        if(expected5mShare <= 0) return null;
        const ratio = change5m / expected5mShare;
        return clamp0100(ratio * 100);
    }
    return change5m > 0 ? 50 : 0; // no established uptrend to accelerate from - partial credit only for still-positive
}

// buys_5m/sells_5m (token) is fresher than trenches' 24h window - the
// same fields config/scoringConfig.js's own gmgn_tokens columns already
// carry every trending tick, zero new fetch.
function buyerPressureScore(token){
    const buys = token.buys_5m != null ? Number(token.buys_5m) : null;
    const sells = token.sells_5m != null ? Number(token.sells_5m) : null;
    if(buys == null || sells == null || buys + sells === 0) return null;
    return clamp0100((buys / (buys + sells)) * 100);
}

// Same real fields tradeManager.js's own closeIfDue already tracks onto
// the position every cycle (last_volume_1h) - reused, not re-fetched.
function volumeTrendScore(token, position){
    const currentVolume1h = token.volume_1h != null ? Number(token.volume_1h) : null;
    if(currentVolume1h == null) return null;
    if(position.last_volume_1h == null) return 70; // no prior reading yet - neutral-positive, never penalize absence
    if(position.last_volume_1h === 0) return currentVolume1h > 0 ? 100 : 50;
    return clamp0100((currentVolume1h / position.last_volume_1h) * 50); // 2x prior volume -> 100, flat -> 50, halved -> 25
}

function liquidityHealthScore(token){
    const liquidity = token.liquidity != null ? Number(token.liquidity) : null;
    const marketCap = token.market_cap != null ? Number(token.market_cap) : null;
    if(liquidity == null || !marketCap) return null;
    const ratio = liquidity / marketCap;
    return clamp0100((ratio / momentumHealthConfig.liquidityHealthCeiling) * 100);
}

// Real historical peak (tokenPriceHistoryRepository, the SAME source
// hasReversalOrDistributionSigns below already uses for its own hard
// structural-breakdown check) plus trenches' real net_buy_24h - a
// continuous version of the same two real facts, not a new data source.
function structuralIntegrityScore(token, trenchesEntry){
    const scores = [];
    const peak = tokenPriceHistoryRepository.findPeakPrice(token.token_address);
    const price = token.price != null ? Number(token.price) : null;
    if(peak != null && peak > 0 && price != null){
        const drawdown = Math.max(0, (peak - price) / peak);
        scores.push(clamp0100((1 - drawdown) * 100));
    }
    const netBuy24h = trenchesEntry?.net_buy_24h != null ? Number(trenchesEntry.net_buy_24h) : null;
    if(netBuy24h != null){
        scores.push(netBuy24h >= 0 ? 100 : 0);
    }
    if(!scores.length) return null;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// Reuses syntheticMarketFilterService's REAL bot/bundler/wash-pattern
// composite (Priority 1) - never a second implementation of the same
// signal. A token that looked clean at BUY time but has since drifted
// toward bot-dominated orderflow scores lower here.
function orderflowIntegrityScore(trenchesEntry){
    if(!trenchesEntry) return null;
    const { syntheticScore } = syntheticMarketFilterService.computeSyntheticBreakdown(trenchesEntry);
    return clamp0100(100 - syntheticScore);
}

// Momentum Health Score - a continuous 0-100 read of whether real,
// already-collected evidence still supports holding, independent of
// TP/SL/trailing. Never fetches anything new; contextStale (the SAME
// flag the existing "ride the winner" check below already respects) is
// returned separately so callers can decide how much to trust a
// low/high score when the underlying market context is stale, rather
// than baking that decision into the score itself.
function computeMomentumHealth(token, position, trenchesEntry){

    const components = {
        priceAcceleration: priceAccelerationScore(token),
        buyerPressure: buyerPressureScore(token),
        volumeTrend: volumeTrendScore(token, position),
        liquidityHealth: liquidityHealthScore(token),
        structuralIntegrity: structuralIntegrityScore(token, trenchesEntry),
        orderflowIntegrity: orderflowIntegrityScore(trenchesEntry)
    };

    const weights = momentumHealthConfig.weights;
    let weightedSum = 0, weightUsed = 0;

    for(const key of Object.keys(weights)){
        const value = components[key];
        if(value == null) continue; // no real data for this component - never guessed, excluded and re-normalized below
        weightedSum += value * weights[key];
        weightUsed += weights[key];
    }

    // No real component had data at all (e.g. a token with almost
    // nothing collected yet) - neutral score, never a fabricated 0 or 100.
    const score = weightUsed > 0 ? weightedSum / weightUsed : 50;

    return { score, components };

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

    // Production Stabilization Final, Section B: `token.marketContextStale`
    // (tradingBotEngine.js's refreshStaleHeldToken) means price/liquidity
    // were just re-verified as real and fresh, but price_change_5m/
    // volume_1h/trenches were NOT - they are whatever was last known,
    // possibly hours old, for a token that has fallen out of the trending
    // scan entirely. Evidence this stale must never be read as "momentum
    // still supports holding" - the same "unknown must not score as good
    // evidence" principle already applied to BUY-side scoring this
    // engagement, now applied to the exit side. Moved ahead of the
    // Momentum Health computation (Arjuna vNext sprint) so BOTH the new
    // early-breakdown check and the existing "ride the winner" check
    // below share the exact same real staleness read.
    const contextStale = Boolean(token.marketContextStale);

    // Arjuna vNext sprint, Priority 2 (Exit Intelligence): computed on
    // EVERY evaluation, independent of ROI/TP/SL - "keluar sebelum rug
    // pull, bukan sesudah" requires looking at momentum health before a
    // position ever reaches its TP floor, not only once it's there.
    // Logged unconditionally (never gated behind an env flag - this
    // sprint's own explicit logging requirement) so every real exit
    // decision is auditable from the server console.
    const momentumHealth = computeMomentumHealth(token, position, trenchesEntry);
    console.log(
        `[momentum-health] token=${position.token_symbol || token.symbol || token.token_address} ` +
        `score=${momentumHealth.score.toFixed(1)} roiPct=${roiPct.toFixed(2)} contextStale=${contextStale} ` +
        `buyerPressure=${momentumHealth.components.buyerPressure ?? "n/a"} ` +
        `sellerPressure=${momentumHealth.components.buyerPressure != null ? (100 - momentumHealth.components.buyerPressure).toFixed(1) : "n/a"} ` +
        `liquidityTrend=${momentumHealth.components.liquidityHealth ?? "n/a"} ` +
        `acceleration=${momentumHealth.components.priceAcceleration ?? "n/a"}`
    );

    // 1. Reversal - the engine's own fresh signal explicitly says AVOID
    //    right now. Checked first, overrides everything, any ROI level.
    if(engineAction === "AVOID"){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=CLOSE reason=REVERSAL`);
        return { shouldClose: true, reason: "REVERSAL", currentPrice, roiPct, momentumHealth };
    }

    // 2. Stop loss - native dynamic SL, unchanged mechanism, unchanged
    //    threshold (computed once at entry from tradePlanService).
    if(stopLossPrice != null && currentPrice <= stopLossPrice){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=CLOSE reason=STOP_LOSS`);
        return { shouldClose: true, reason: "STOP_LOSS", currentPrice, roiPct, momentumHealth };
    }

    // 2b. Momentum Health breakdown - NEW (Arjuna vNext sprint, Priority
    //     2). Fires regardless of ROI, even below minTpPct and above the
    //     hard Stop Loss floor: "walaupun trailing belum kena, walaupun
    //     TP belum kena." Only on FRESH data (never contextStale - a
    //     stale/uncertain read must never be trusted to force a close,
    //     the mirror image of the existing "stale must never look like
    //     support" rule a few lines below) and only below
    //     hardBreakdownFloor (momentumHealthConfig.js - deliberately
    //     conservative, multiple real signals simultaneously bad, never
    //     a single noisy field). Never touches REVERSAL/STOP_LOSS above,
    //     never touches the sub-minTpPct "keep running" default below for
    //     a position that ISN'T breaking down.
    if(!contextStale && momentumHealth.score <= momentumHealthConfig.hardBreakdownFloor){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=CLOSE reason=MOMENTUM_HEALTH_BREAKDOWN score=${momentumHealth.score.toFixed(1)}`);
        return { shouldClose: true, reason: "MOMENTUM_HEALTH_BREAKDOWN", currentPrice, roiPct, momentumHealth };
    }

    // 3. Below the minimum target - nothing else to evaluate yet,
    //    keep running.
    if(roiPct < minTpPct){
        return { shouldClose: false, currentPrice, roiPct, momentumHealth };
    }

    // 3b. Profit Protection via momentum decay - NEW (Arjuna vNext
    //     sprint, Priority 3). Only once already at/above minTpPct
    //     (real, locked-in profit on the table) and only on fresh data.
    //     A higher/easier-to-trigger bar than hardBreakdownFloor above -
    //     "profit tinggi + momentum mulai rusak -> SELL", not "wait for
    //     the full 4-condition check below or a trailing stop to give
    //     the profit back first." Checked BEFORE the existing
    //     momentumSustained check, which is left completely unchanged as
    //     the fallback for everything this doesn't catch.
    if(!contextStale && momentumHealth.score <= momentumHealthConfig.profitProtectionDecayFloor){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=CLOSE reason=PROFIT_PROTECTION_MOMENTUM_DECAY score=${momentumHealth.score.toFixed(1)} roiPct=${roiPct.toFixed(2)}`);
        return { shouldClose: true, reason: "PROFIT_PROTECTION_MOMENTUM_DECAY", currentPrice, roiPct, momentumHealth };
    }

    // 4. At/above the minimum target - hold ONLY while real momentum
    //    still supports it. ALL four must hold; any single failure
    //    exits immediately (momentum has to be simultaneously strong,
    //    buyer-led, still building, and free of reversal signs - not
    //    "mostly fine").
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
        return { shouldClose: true, reason: contextStale ? "MOMENTUM_WEAKENING_STALE_CONTEXT" : "MOMENTUM_WEAKENING", currentPrice, roiPct, momentumHealth };
    }

    return { shouldClose: false, currentPrice, roiPct, momentumHealth };

}

module.exports = { evaluateDynamicExit, MIN_TP_PCT, computeMomentumHealth };
