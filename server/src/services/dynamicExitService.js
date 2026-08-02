// services/dynamicExitService.js - Arjuna V3 (FINAL SPRINT), Part 10.
// Exit is now a DETERMINISTIC state machine (Steps 1-7 of the final
// spec), completely replacing the previous momentum-driven "ride the
// winner while evidence supports it" philosophy:
//   1. Hard Stop Loss -20% (fixed, computed from the position's own
//      entry_price - independent of tradePlanService's separate dynamic
//      stop-loss band, which still governs the "AI Trade Plan" display
//      only and is untouched by this file).
//   2. TP1 at +25% ROI -> sell 50% unconditionally.
//   3. A 5-minute timer starts the instant TP1 fires.
//   4. Second Target: remaining position reaches +50% ROI -> sell all.
//   5. Time Exit: timer expires (5 min since TP1) and price never
//      reached +40% ROI -> sell the remainder.
//   6. Profit Protection: after TP1, remaining profit drops below +15%
//      -> sell the remainder immediately, no trailing, no waiting.
//   7. Emergency Exit: Momentum Health (unchanged machinery, computeMomentumHealth
//      below) is now ONLY a backstop for severe structural collapse -
//      checked every cycle, can fire at ANY point (even pre-TP1,
//      overriding everything else) but never drives a normal exit
//      anymore.
// Every number above lives in config/exitSystemConfig.js - this file
// owns the state-machine logic only. Returns { action: "HOLD" |
// "SELL_PARTIAL" | "SELL_ALL", sellFraction, reason, currentPrice,
// roiPct, momentumHealth } - tradeManager.js's closeIfDue interprets
// SELL_PARTIAL as a new partialClose() call (position stays OPEN with a
// reduced size) and SELL_ALL as the existing finalizeClose().

const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");
const momentumHealthConfig = require("../config/momentumHealthConfig");
const syntheticMarketFilterService = require("./syntheticMarketFilterService");
const exitConfig = require("../config/exitSystemConfig");

// tradingBotEngine.js's isInProfitProtectionTerritory reads this to
// decide when a held position needs its on-demand realtime price
// refresh (bypassing the 30s trending snapshot) - now aligned to Part
// 10's own TP1 trigger (25%, exitSystemConfig.tp1.triggerPct) so that
// realtime refresh kicks in exactly when the new deterministic TP1
// check needs a fresh price, not the old 15% target.
const MIN_TP_PCT = exitConfig.tp1.triggerPct;

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
// position: real trading_bot_positions row - Part 10's state machine
// needs tp1_hit_at (null until TP1 fires; set by tradeManager.js's
// partialClose) and mfe_pct (the position's own real highest ROI ever
// reached, already tracked every cycle) in addition to the fields the
// exit system already used. stopLossPrice/minTpPct/buyerDominanceRatio
// parameters are still accepted for call-site compatibility but no
// longer drive this function's own logic (see the file header) - Step
// 1's Stop Loss is now always the deterministic -20% from entry_price,
// and there is no more minTpPct/buyerDominanceRatio concept.
//
// Returns { action: "HOLD"|"SELL_PARTIAL"|"SELL_ALL", sellFraction,
// reason, currentPrice, roiPct, momentumHealth }.
function evaluateDynamicExit({ position, token, trenchesEntry }){

    const currentPrice = Number(token.price) || position.current_price || position.entry_price;
    const roiPct = ((currentPrice / position.entry_price) - 1) * 100;
    const contextStale = Boolean(token.marketContextStale);

    // Step 7 (Emergency Exit) - computed and logged on EVERY evaluation,
    // regardless of TP/SL/timer state, but only ever ACTS as a backstop
    // for severe structural collapse (buyers disappear, liquidity
    // collapse, massive sell pressure, structural breakdown) - never the
    // primary exit driver anymore. Never trusted on stale/uncertain data.
    const momentumHealth = computeMomentumHealth(token, position, trenchesEntry);
    console.log(
        `[momentum-health] token=${position.token_symbol || token.symbol || token.token_address} ` +
        `score=${momentumHealth.score.toFixed(1)} roiPct=${roiPct.toFixed(2)} contextStale=${contextStale} tp1HitAt=${position.tp1_hit_at || "none"} ` +
        `buyerPressure=${momentumHealth.components.buyerPressure ?? "n/a"} ` +
        `sellerPressure=${momentumHealth.components.buyerPressure != null ? (100 - momentumHealth.components.buyerPressure).toFixed(1) : "n/a"} ` +
        `liquidityTrend=${momentumHealth.components.liquidityHealth ?? "n/a"} ` +
        `acceleration=${momentumHealth.components.priceAcceleration ?? "n/a"}`
    );

    if(!contextStale && momentumHealth.score <= exitConfig.emergencyMomentumHealthFloor){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=SELL_ALL reason=MOMENTUM_HEALTH_EMERGENCY score=${momentumHealth.score.toFixed(1)}`);
        return { action: "SELL_ALL", sellFraction: 1, reason: "MOMENTUM_HEALTH_EMERGENCY", currentPrice, roiPct, momentumHealth };
    }

    // Step 1 - Hard Stop Loss, -20% fixed from entry_price. Always
    // fresh, never gated on staleness (a real price crash is real
    // regardless of how stale price_change_5m/trenches are).
    const stopLossFloor = position.entry_price * (1 - exitConfig.hardStopLossPct / 100);
    if(currentPrice <= stopLossFloor){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=SELL_ALL reason=STOP_LOSS`);
        return { action: "SELL_ALL", sellFraction: 1, reason: "STOP_LOSS", currentPrice, roiPct, momentumHealth };
    }

    const tp1Hit = Boolean(position.tp1_hit_at);

    if(!tp1Hit){

        // Step 2/3 - TP1: at +25% ROI, sell 50% unconditionally and
        // start the 5-minute timer (tradeManager.js's partialClose
        // stamps tp1_hit_at/tp1_price - this function only decides WHEN
        // to trigger it).
        if(roiPct >= exitConfig.tp1.triggerPct){
            console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=SELL_PARTIAL reason=TP1 roiPct=${roiPct.toFixed(2)}`);
            return { action: "SELL_PARTIAL", sellFraction: exitConfig.tp1.sellFraction, reason: "TP1", currentPrice, roiPct, momentumHealth };
        }

        return { action: "HOLD", currentPrice, roiPct, momentumHealth };

    }

    // Post-TP1 state machine - Steps 4/5/6.

    // Step 4 - Second Target: remaining position reaches +50% ROI ->
    // sell everything left. Checked before Step 6's profit-protection
    // floor since it's the more decisive exit.
    if(roiPct >= exitConfig.secondTargetPct){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=SELL_ALL reason=SECOND_TARGET roiPct=${roiPct.toFixed(2)}`);
        return { action: "SELL_ALL", sellFraction: 1, reason: "SECOND_TARGET", currentPrice, roiPct, momentumHealth };
    }

    // Step 6 - Profit Protection: remaining profit drops below +15% ->
    // sell immediately. No trailing, no waiting.
    if(roiPct < exitConfig.profitProtectionFloorPct){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=SELL_ALL reason=PROFIT_PROTECTION roiPct=${roiPct.toFixed(2)}`);
        return { action: "SELL_ALL", sellFraction: 1, reason: "PROFIT_PROTECTION", currentPrice, roiPct, momentumHealth };
    }

    // Step 5 - Time Exit: 5-minute timer (since TP1) expired and price
    // never reached +40% ROI - checked against the position's own real
    // mfe_pct (highest ROI ever actually reached), never re-derived.
    const minutesSinceTp1 = (Date.now() - new Date(`${String(position.tp1_hit_at).replace(" ", "T")}Z`).getTime()) / 60000;
    const timerExpired = minutesSinceTp1 >= exitConfig.timerMinutes;
    const everReached40 = (position.mfe_pct ?? roiPct) >= exitConfig.timeExitRequiredPct;

    if(timerExpired && !everReached40){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=SELL_ALL reason=TIME_EXIT mfePct=${position.mfe_pct}`);
        return { action: "SELL_ALL", sellFraction: 1, reason: "TIME_EXIT", currentPrice, roiPct, momentumHealth };
    }

    return { action: "HOLD", currentPrice, roiPct, momentumHealth };

}

module.exports = { evaluateDynamicExit, MIN_TP_PCT, computeMomentumHealth };
