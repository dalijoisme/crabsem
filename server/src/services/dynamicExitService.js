// services/dynamicExitService.js - Arjuna V4 (Sprint 11), Part 3. Exit
// stays the deterministic state machine Arjuna V3 introduced, with the
// FINAL numbers/steps below (wholesale replacement of V3's TP1/Second-
// Target/Profit-Protection values - the state-machine MECHANISM is
// unchanged):
//   1. Hard Stop Loss -20% (fixed, computed from the position's own
//      entry_price - independent of tradePlanService's separate dynamic
//      stop-loss band, which still governs the "AI Trade Plan" display
//      only and is untouched by this file). Unconditional - covers both
//      the full pre-TP1 position and the post-TP1 remainder.
//   2. TP1 at +25% ROI -> sell 80% unconditionally (capital protection
//      is the primary goal, not maximizing profit).
//   3. A 5-minute timer starts the instant TP1 fires.
//   4/5. Free Ride Mode - the remaining 20% rides with NO intermediate
//      profit-protection floor: TP2 at +100% sells the entire remainder;
//      otherwise Time Exit sells the remainder unconditionally once the
//      Step 3 timer expires (a pure timer fallback, not another profit
//      floor - that would defeat "free ride").
//   6. Emergency Exit: Momentum Health (unchanged machinery,
//      computeMomentumHealth below) remains ONLY a backstop for severe
//      structural collapse - checked every cycle, can fire at ANY point
//      (even pre-TP1, overriding everything else) but never drives a
//      normal exit.
// Every number above lives in config/exitSystemConfig.js - this file
// owns the state-machine logic only. Returns { action: "HOLD" |
// "SELL_PARTIAL" | "SELL_ALL", sellFraction, reason, currentPrice,
// roiPct, momentumHealth } - tradeManager.js's closeIfDue interprets
// SELL_PARTIAL as a partialClose() call (position stays OPEN with a
// reduced size) and SELL_ALL as finalizeClose().

const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");
const momentumHealthConfig = require("../config/momentumHealthConfig");
const syntheticMarketFilterService = require("./syntheticMarketFilterService");
const exitConfig = require("../config/exitSystemConfig");
// Arjuna V4 Phase 2 (Realtime Pulse, exit side) - same read-only accessor
// the entry side (researchEngineFactory.js) already uses. Never triggers
// a new computation/GMGN call - recomputed from whatever the shared
// in-memory buffer already holds this instant.
const realtimePulseService = require("./realtimePulseService");
// Arjuna V4 (Sprint 11), Part 1/4: THE single ROI formula - this file's
// own roiPct is a TRIGGER (when to sell), explicitly still allowed to
// be snapshot-based (Part 4), but must still call the SAME shared
// helper everything else does, never its own inline copy of the formula.
const { computeRoiPct } = require("./roiCalculator");

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
//
// Arjuna V4 Phase 2 (Momentum Weakening Evolution) - realtimeSignal is
// OPTIONAL and TRAILING (dynamicExitService.test.js's own direct 3-arg
// call is byte-identical to before this sprint). It is
// realtimePulseService.js's computed signal set for this token
// (velocity/acceleration/direction/consistency of buyerPressure/
// volumeTrend/etc, built from real poll-to-poll history rather than this
// function's own existing single-snapshot proxies - see that file's own
// header for why this is infrastructure math, not a trading formula).
// `components`/`weights`/`score` below are COMPLETELY UNCHANGED -
// realtimeSignal is only ever attached as `realtimeFacts`, additive
// observability for the Daily Trading Review and dashboard. The Solution
// Architect's eventual formula for how this richer trend data should
// affect the score is deliberately not invented here.
function computeMomentumHealth(token, position, trenchesEntry, realtimeSignal){

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

    return { score, components, realtimeFacts: realtimeSignal ?? null };

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
// Arjuna V4 FINAL DECISION ENGINE SPRINT - Dynamic TP / Dynamic SL /
// Adaptive Time Exit, now real (no longer the Phase 2 inert
// placeholders). "Momentum weakening"/"improving" reuses the SAME
// cross-signal provisional vote realtimePulseService.js already computes
// for the entry side (flowDirectionVoteProvisional/consistencyVoteProvisional)
// - one real, already-computed classification, not a second detector.
//
// Magnitude: the Architect's own explicit sprint spec gives exact
// percentages for the ENTRY-side confidence adjustment (Realtime Pulse
// capped at ±15% - config/realtimeAdjustmentConfig.js's pulse.maxAdjustmentPct)
// but does not give a separate number for how much the EXIT-side
// TP/SL/Timer should adapt. Rather than inventing an unrelated new
// magnitude, this file reuses that SAME ±15% figure - the one real
// "how much should realtime momentum move something" number the
// Architect specified - applied here to exit timing/targets instead of
// confidence. This is a documented implementation decision (see the
// FINAL DECISION ENGINE SPRINT implementation report), not a fabricated
// formula.
//
// Stop Loss ONLY ever tightens under weakening momentum - it is never
// loosened under improving momentum. Loosening a safety floor because
// "momentum looks good" would increase real risk for a marginal,
// unproven benefit - the conservative choice for a system now running
// real money. TP1/TP2/Timer adapt symmetrically in both directions
// (tighter when weakening, more room when improving) since those govern
// profit-taking, not capital protection.
const REALTIME_EXIT_ADJUSTMENT_PCT = require("../config/realtimeAdjustmentConfig").pulse.maxAdjustmentPct;

// Never let the adaptive timer collapse toward zero (a degenerate,
// near-instant Time Exit) - one real, already-established number reused
// a second time (exitSystemConfig.js's own tp1.sellFraction is the only
// other "floor" concept in this file; for a TIME floor specifically, 1
// minute is the shortest interval that still gives Free Ride Mode a
// genuine chance to act, well above the exit-evaluation loop's own
// 1-30s cadence so it can never be mistaken for that loop's own
// granularity).
const MIN_ADAPTIVE_TIMER_MINUTES = 1;

function isMomentumWeakening(realtimePulse){
    return realtimePulse?.flowDirectionVoteProvisional === "DOWN";
}

function isMomentumImproving(realtimePulse){
    return realtimePulse?.flowDirectionVoteProvisional === "UP" && realtimePulse?.consistencyVoteProvisional === "MOSTLY_CONSISTENT";
}

// Dynamic SL - tightens (smaller magnitude = triggers sooner = more
// protective) under weakening momentum; never loosened.
function resolveEffectiveStopLossPct(position, token, realtimePulse){
    void position; void token;
    if(isMomentumWeakening(realtimePulse)){
        return exitConfig.hardStopLossPct * (1 - REALTIME_EXIT_ADJUSTMENT_PCT / 100);
    }
    return exitConfig.hardStopLossPct;
}

// Dynamic TP1 - take profit sooner when momentum is weakening (secure
// capital before it can give back further), let it run further before
// the first target when momentum is genuinely, consistently improving.
function resolveEffectiveTp1TriggerPct(position, token, realtimePulse){
    void position; void token;
    if(isMomentumWeakening(realtimePulse)) return exitConfig.tp1.triggerPct * (1 - REALTIME_EXIT_ADJUSTMENT_PCT / 100);
    if(isMomentumImproving(realtimePulse)) return exitConfig.tp1.triggerPct * (1 + REALTIME_EXIT_ADJUSTMENT_PCT / 100);
    return exitConfig.tp1.triggerPct;
}

// Dynamic TP2 (Free Ride Mode's own target) - same shape as TP1.
function resolveEffectiveTp2Pct(position, token, realtimePulse){
    void position; void token;
    if(isMomentumWeakening(realtimePulse)) return exitConfig.tp2Pct * (1 - REALTIME_EXIT_ADJUSTMENT_PCT / 100);
    if(isMomentumImproving(realtimePulse)) return exitConfig.tp2Pct * (1 + REALTIME_EXIT_ADJUSTMENT_PCT / 100);
    return exitConfig.tp2Pct;
}

// Adaptive Time Exit - "must become adaptive, never purely fixed time"
// (Architect's own explicit requirement). Shortens the Free Ride timer
// when momentum is weakening (cut a fading move loose sooner), extends
// it when genuinely improving (let a real continuation ride longer),
// floored so it can never collapse to a degenerate near-zero window.
function resolveEffectiveTimerMinutes(position, token, realtimePulse){
    void position; void token;
    let minutes = exitConfig.timerMinutes;
    if(isMomentumWeakening(realtimePulse)) minutes = exitConfig.timerMinutes * (1 - REALTIME_EXIT_ADJUSTMENT_PCT / 100);
    else if(isMomentumImproving(realtimePulse)) minutes = exitConfig.timerMinutes * (1 + REALTIME_EXIT_ADJUSTMENT_PCT / 100);
    return Math.max(MIN_ADAPTIVE_TIMER_MINUTES, minutes);
}

// Returns { action: "HOLD"|"SELL_PARTIAL"|"SELL_ALL", sellFraction,
// reason, currentPrice, roiPct, momentumHealth }.
function evaluateDynamicExit({ position, token, trenchesEntry }){

    const currentPrice = Number(token.price) || position.current_price || position.entry_price;
    const roiPct = computeRoiPct(position.entry_price, currentPrice);
    const contextStale = Boolean(token.marketContextStale);

    // Arjuna V4 Phase 2 (Realtime position monitoring improvements) -
    // read-only, never blocks, never a new GMGN call - see this file's
    // own import comment. Threaded into computeMomentumHealth below
    // (additive observability only, see that function's own header) and
    // into the three resolver functions above (currently unused by them,
    // available once a real formula lands).
    const realtimePulse = realtimePulseService.getLatestSignals(token.token_address);

    // Step 7 (Emergency Exit) - computed and logged on EVERY evaluation,
    // regardless of TP/SL/timer state, but only ever ACTS as a backstop
    // for severe structural collapse (buyers disappear, liquidity
    // collapse, massive sell pressure, structural breakdown) - never the
    // primary exit driver anymore. Never trusted on stale/uncertain data.
    const momentumHealth = computeMomentumHealth(token, position, trenchesEntry, realtimePulse);
    console.log(
        `[momentum-health] token=${position.token_symbol || token.symbol || token.token_address} ` +
        `score=${momentumHealth.score.toFixed(1)} roiPct=${roiPct.toFixed(2)} contextStale=${contextStale} tp1HitAt=${position.tp1_hit_at || "none"} ` +
        `buyerPressure=${momentumHealth.components.buyerPressure ?? "n/a"} ` +
        `sellerPressure=${momentumHealth.components.buyerPressure != null ? (100 - momentumHealth.components.buyerPressure).toFixed(1) : "n/a"} ` +
        `liquidityTrend=${momentumHealth.components.liquidityHealth ?? "n/a"} ` +
        `acceleration=${momentumHealth.components.priceAcceleration ?? "n/a"} ` +
        // Arjuna V4 Phase 2 (Realtime exit observability) - the real
        // computed trend direction/consistency for this held position's
        // token, same provisional cross-signal summary the entry side
        // logs - see realtimePulseService.js's own header for why this
        // is observability-only, never a decision input yet.
        `realtimePulseFlow=${realtimePulse.flowDirectionVoteProvisional ?? "n/a"} realtimePulseConsistency=${realtimePulse.consistencyVoteProvisional ?? "n/a"}`
    );

    if(!contextStale && momentumHealth.score <= exitConfig.emergencyMomentumHealthFloor){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=SELL_ALL reason=MOMENTUM_HEALTH_EMERGENCY score=${momentumHealth.score.toFixed(1)}`);
        return { action: "SELL_ALL", sellFraction: 1, reason: "MOMENTUM_HEALTH_EMERGENCY", currentPrice, roiPct, momentumHealth };
    }

    // Arjuna V4 FINAL DECISION ENGINE SPRINT - MAE-aware accelerated
    // exit ("Flow Exit"). Architect's own explicit rule: "If MAE expands
    // AND Realtime momentum weakens: Accelerate exit." Implemented
    // literally - no additional magnitude gate invented beyond what was
    // specified: a real, already-existing drawdown (mae_pct < 0, so
    // "expands" is a meaningful direction, not a first dip from zero)
    // that gets WORSE this exact cycle (roiPct <= the previous mae_pct,
    // i.e. a new low is being set right now - the same "compare this
    // cycle's real reading against the position's own last real value"
    // shape volumeTrendScore already uses), combined with the same
    // real-time weakening classification used throughout this file.
    // Checked before Hard Stop Loss so it can genuinely accelerate past
    // what the (now-tighter, see resolveEffectiveStopLossPct) fixed stop
    // would otherwise have waited for.
    if(!contextStale && position.mae_pct < 0 && roiPct <= position.mae_pct && isMomentumWeakening(realtimePulse)){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=SELL_ALL reason=MAE_ACCELERATED_EXIT roiPct=${roiPct.toFixed(2)} priorMaePct=${position.mae_pct.toFixed(2)}`);
        return { action: "SELL_ALL", sellFraction: 1, reason: "MAE_ACCELERATED_EXIT", currentPrice, roiPct, momentumHealth };
    }

    // Step 1 - Hard Stop Loss. Always fresh, never gated on staleness (a
    // real price crash is real regardless of how stale price_change_5m/
    // trenches are). Sourced via resolveEffectiveStopLossPct - real and
    // adaptive now (tightens under weakening real-time momentum, never
    // loosened - see that function's own header).
    const stopLossFloor = position.entry_price * (1 - resolveEffectiveStopLossPct(position, token, realtimePulse) / 100);
    if(currentPrice <= stopLossFloor){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=SELL_ALL reason=STOP_LOSS`);
        return { action: "SELL_ALL", sellFraction: 1, reason: "STOP_LOSS", currentPrice, roiPct, momentumHealth };
    }

    // Arjuna V4 FINAL DECISION ENGINE SPRINT - momentum-aware early exit
    // ("Momentum Exit" / MFE-aware exit). Architect's own explicit rule:
    // "If Momentum weakens AND MFE >15%: Exit earlier." Uses the
    // position's own real, already-tracked mfe_pct (the highest ROI this
    // position has ever genuinely reached, updated every cycle by
    // tradeManager.js) rather than the current roiPct, since a real
    // meaningful profit having been SEEN is what this rule protects,
    // even if price has since pulled back. Checked regardless of TP1
    // state - a real profit worth protecting can exist both pre-TP1 (a
    // fast mover that ran past 15% without yet reaching the 25% TP1
    // trigger) and post-TP1 during Free Ride Mode.
    if(!contextStale && position.mfe_pct > 15 && isMomentumWeakening(realtimePulse)){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=SELL_ALL reason=MOMENTUM_WEAKENING_EARLY_EXIT roiPct=${roiPct.toFixed(2)} mfePct=${position.mfe_pct.toFixed(2)}`);
        return { action: "SELL_ALL", sellFraction: 1, reason: "MOMENTUM_WEAKENING_EARLY_EXIT", currentPrice, roiPct, momentumHealth };
    }

    const tp1Hit = Boolean(position.tp1_hit_at);

    if(!tp1Hit){

        // Step 2/3 - TP1 (Dynamic TP): at the adaptive trigger ROI
        // (tightens under weakening momentum, widens under genuinely
        // improving momentum - see resolveEffectiveTp1TriggerPct's own
        // header), sell 80% unconditionally and start the timer
        // (tradeManager.js's partialClose stamps tp1_hit_at/tp1_price -
        // this function only decides WHEN to trigger it).
        if(roiPct >= resolveEffectiveTp1TriggerPct(position, token, realtimePulse)){
            console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=SELL_PARTIAL reason=TP1 roiPct=${roiPct.toFixed(2)}`);
            return { action: "SELL_PARTIAL", sellFraction: exitConfig.tp1.sellFraction, reason: "TP1", currentPrice, roiPct, momentumHealth };
        }

        return { action: "HOLD", currentPrice, roiPct, momentumHealth };

    }

    // Free Ride Mode (post-TP1) - Steps 4/5. The remaining 20% has NO
    // intermediate profit-protection floor - only TP2 or the timer
    // decide its fate, deliberately, so it can genuinely "free ride".

    // Step 4 - TP2 (Dynamic TP): remaining position reaches the
    // adaptive TP2 ROI (widens under improving momentum, tightens under
    // weakening - see resolveEffectiveTp2Pct's own header) -> sell
    // everything left.
    if(roiPct >= resolveEffectiveTp2Pct(position, token, realtimePulse)){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=SELL_ALL reason=TP2 roiPct=${roiPct.toFixed(2)}`);
        return { action: "SELL_ALL", sellFraction: 1, reason: "TP2", currentPrice, roiPct, momentumHealth };
    }

    // Step 5 - Time Exit (Adaptive Time Exit): the adaptive timer (since
    // TP1, shortened under weakening momentum / extended under improving
    // momentum - see resolveEffectiveTimerMinutes's own header) expired
    // and TP2 hasn't fired yet - sell the remainder unconditionally,
    // regardless of its ROI at that moment. A pure timer fallback, not
    // another profit floor (that would defeat Free Ride Mode).
    const minutesSinceTp1 = (Date.now() - new Date(`${String(position.tp1_hit_at).replace(" ", "T")}Z`).getTime()) / 60000;
    const timerExpired = minutesSinceTp1 >= resolveEffectiveTimerMinutes(position, token, realtimePulse);

    if(timerExpired){
        console.log(`[momentum-health] token=${position.token_symbol || token.symbol} decision=SELL_ALL reason=TIME_EXIT roiPct=${roiPct.toFixed(2)}`);
        return { action: "SELL_ALL", sellFraction: 1, reason: "TIME_EXIT", currentPrice, roiPct, momentumHealth };
    }

    return { action: "HOLD", currentPrice, roiPct, momentumHealth };

}

module.exports = {
    evaluateDynamicExit, MIN_TP_PCT, computeMomentumHealth,
    // Arjuna V4 FINAL DECISION ENGINE SPRINT - exported for direct
    // testing/observability of the real, adaptive Dynamic TP/SL/Time
    // Exit formulas (see their own header comment above).
    resolveEffectiveStopLossPct, resolveEffectiveTp1TriggerPct, resolveEffectiveTp2Pct, resolveEffectiveTimerMinutes,
    isMomentumWeakening, isMomentumImproving
};
