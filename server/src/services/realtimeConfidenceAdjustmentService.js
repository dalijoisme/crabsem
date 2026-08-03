// services/realtimeConfidenceAdjustmentService.js - Arjuna V4 FINAL
// DECISION ENGINE SPRINT. Implements the Solution Architect's final,
// explicit production formulas (config/realtimeAdjustmentConfig.js) for
// how Realtime Pulse/Token Age/Smart Money/KOL/Fake Pump adjust
// CONFIDENCE ONLY - never the entry score, never the action tier, never
// a veto (the Architect's own governing constraint). Production V2's
// unified entry score is never read or written by this file.
//
// Entry Priority (Architect's own order, followed here for the
// breakdown/reasons narrative - multiplication is commutative so it
// doesn't change the numeric result, only the order findings are
// reported in): Realtime Pulse -> Token Age -> Fake Pump Penalty ->
// KOL Evolution -> Smart Money Evolution.
//
// Every adjustment is computed from REAL, already-computed data
// (realtimePulseService.js's per-series velocity/direction/consistency,
// syntheticMarketFilterService.js's real orderflow breakdown) using real
// elapsed-time-based signals - never a guess, never fabricated. Missing/
// insufficient data always resolves to NEUTRAL (0% / 1.00x), matching
// this codebase's universal "never guess a penalty or bonus" convention.

const config = require("../config/realtimeAdjustmentConfig");

function clamp(value, min, max){
    return Math.max(min, Math.min(max, value));
}

// TOKEN AGE - Architect's exact bucket table, upper-bound-exclusive
// except the last. Missing age = neutral (1.00x, never guessed) -
// "never block BUY solely because of age" extends to "never penalize
// on missing age data" too.
function resolveTokenAgeMultiplier(ageMinutes){

    if(ageMinutes == null){
        return { multiplier: 1.00, reason: "Token age unknown - neutral multiplier applied" };
    }

    const bucket = config.tokenAgeMultiplier.find(b => ageMinutes <= b.maxMinutes);
    const multiplier = bucket ? bucket.multiplier : 1.00;

    return { multiplier, reason: `Token age ${ageMinutes.toFixed(1)}min -> ${multiplier}x timing multiplier` };

}

// Shared 3-bucket classification (Architect's own explicit shape,
// reused for Smart Money/KOL/Pulse rather than three independently-
// invented curves): "strong improving" requires BOTH the latest
// direction AND the two-transition consistency to agree upward;
// "clearly weakening" requires the same agreement downward. Anything
// else (mixed signals, a single noisy reading, insufficient history) is
// neutral - the deliberately conservative middle case, never guessed
// toward either extreme.
function classifySeriesStrength(seriesSignal){

    if(!seriesSignal || seriesSignal.direction == null){
        return "NEUTRAL";
    }

    if(seriesSignal.direction === "UP" && seriesSignal.consistency === "CONSISTENT_UP") return "IMPROVING";
    if(seriesSignal.direction === "DOWN" && seriesSignal.consistency === "CONSISTENT_DOWN") return "WEAKENING";

    return "NEUTRAL";

}

// SMART MONEY EVOLUTION - realtime flow of smartMoneyNetUsd specifically
// (velocity/acceleration/direction/consistency, never a static
// snapshot - see realtimePulseService.js). Architect's exact 3-bucket
// percentages.
function resolveSmartMoneyAdjustment(realtimePulse){

    const series = realtimePulse?.signals?.smartMoneyNetUsd;
    const strength = classifySeriesStrength(series);

    if(strength === "IMPROVING") return { pct: config.smartMoney.strongImprovingPct, reason: "Smart money flow strongly improving (consistent real-time accumulation)" };
    if(strength === "WEAKENING") return { pct: config.smartMoney.clearlyWeakeningPct, reason: "Smart money flow clearly weakening (consistent real-time distribution)" };

    return { pct: config.smartMoney.neutralPct, reason: "Smart money flow neutral or insufficient real-time history" };

}

// KOL EVOLUTION - same philosophy, kolNetUsd specifically, own cap.
function resolveKolAdjustment(realtimePulse){

    const series = realtimePulse?.signals?.kolNetUsd;
    const strength = classifySeriesStrength(series);

    let pct = config.kol.neutralPct;
    let reason = "KOL flow neutral or insufficient real-time history";

    if(strength === "IMPROVING"){ pct = config.kol.strongImprovingPct; reason = "KOL flow strongly improving (consistent real-time accumulation)"; }
    else if(strength === "WEAKENING"){ pct = config.kol.clearlyWeakeningPct; reason = "KOL flow clearly weakening (consistent real-time distribution)"; }

    return { pct: clamp(pct, -config.kol.maxAdjustmentPct, config.kol.maxAdjustmentPct), reason };

}

// REALTIME PULSE - the general momentum/flow read, using the SAME
// cross-signal provisional vote realtimePulseService.js already computes
// (majority direction/consistency across price, liquidity, volume,
// buy/sell pressure, net flow - every tracked series EXCEPT the
// smart-money/KOL ones, which have their own dedicated sections above).
// Same 3-bucket shape as Smart Money/KOL, scaled to Pulse's own
// Architect-specified cap (the one number given for this signal; the
// bucket-shape itself is the same pattern already established twice
// above, applied consistently rather than invented a third way).
function resolvePulseAdjustment(realtimePulse){

    const direction = realtimePulse?.flowDirectionVoteProvisional;
    const consistency = realtimePulse?.consistencyVoteProvisional;
    const cap = config.pulse.maxAdjustmentPct;

    if(direction === "UP" && consistency === "MOSTLY_CONSISTENT"){
        return { pct: cap, reason: "Realtime Pulse strongly improving (consistent multi-signal upward flow)" };
    }

    if(direction === "DOWN" && consistency === "MOSTLY_CONSISTENT"){
        return { pct: -cap, reason: "Realtime Pulse clearly weakening (consistent multi-signal downward flow)" };
    }

    return { pct: 0, reason: "Realtime Pulse neutral, mixed, or insufficient real-time history" };

}

// FAKE PUMP DETECTION - penalty only, never a veto (a genuine security
// risk remains researchEngineFactory.js's existing, untouched hard
// safety veto - honeypot/hard blacklist/critical illiquidity - this is
// a separate, softer, stackable confidence penalty).
//
// Suspicious pump: a realtime-momentum SHAPE (price trending up without
// buy-pressure/volume/net-flow confirming it across the same real polls)
// - this is what Section 6 of the Phase 2 design doc calls "price rising
// in isolation." Uses Realtime Pulse data, not the synthetic filter.
//
// Wash trading / coordinated activity: real orderflow SHAPE, from
// syntheticMarketFilterService.js's already-computed breakdown. Detection
// threshold reuses the ONE existing "how elevated is elevated" bound
// this codebase already established for exactly this class of signal
// (scoringConfig.js's entryScore.washTradingPenalty.confidenceThreshold,
// 70) - applied here to the specific sub-groups of the breakdown that
// correspond to each named category, never a second invented number.
function resolveFakePumpPenalty({ realtimePulse, syntheticBreakdown }){

    const reasons = [];
    let penaltyPct = 0;

    // Suspicious pump.
    const priceSignal = realtimePulse?.signals?.price;
    const priceUp = priceSignal?.direction === "UP";
    const confirmingSignals = ["buyPressure", "volume1h", "netFlow5m"].map(key => realtimePulse?.signals?.[key]);
    const hasConfirmation = confirmingSignals.some(s => s?.direction === "UP");
    const hasAnyRealtimeReadOnConfirmers = confirmingSignals.some(s => s?.direction != null);

    if(priceUp && hasAnyRealtimeReadOnConfirmers && !hasConfirmation){
        penaltyPct += config.fakePump.suspiciousPumpPct;
        reasons.push("Suspicious pump - price rising without real-time buy pressure/volume/net-flow confirmation");
    }

    // Wash trading.
    const breakdown = syntheticBreakdown?.breakdown || {};
    const syntheticScore = syntheticBreakdown?.syntheticScore ?? 0;
    if(syntheticBreakdown?.washFlagged === true || syntheticScore >= config.fakePump.elevatedThreshold){
        penaltyPct += config.fakePump.washTradingPct;
        reasons.push(`Wash trading pattern detected (syntheticScore=${Math.round(syntheticScore)}${syntheticBreakdown?.washFlagged ? ", GMGN wash-trading flag set" : ""})`);
    }

    // Coordinated activity - the specific coordinated-wallet-behavior
    // sub-group of the same real breakdown (bundler/rat-trader/entrapment),
    // not the whole composite.
    const coordinatedFields = [breakdown.bundlerTraderAmountRate, breakdown.ratTraderAmountRate, breakdown.entrapmentRatio].filter(v => v != null);
    const coordinatedAvg = coordinatedFields.length ? coordinatedFields.reduce((a,b) => a+b, 0) / coordinatedFields.length : 0;
    if(coordinatedFields.length && coordinatedAvg >= config.fakePump.elevatedThreshold){
        penaltyPct += config.fakePump.coordinatedActivityPct;
        reasons.push(`Coordinated wallet activity detected (bundler/rat-trader/entrapment avg=${Math.round(coordinatedAvg)})`);
    }

    // Multiple penalties stack, but the combined penalty is hard-capped
    // (Architect's own explicit ceiling).
    const cappedPct = Math.max(penaltyPct, config.fakePump.maxCombinedPenaltyPct);

    return { pct: cappedPct, reasons };

}

// THE combined adjustment - independent components, multiplicatively
// combined (order-independent mathematically; the Architect's own
// priority order is preserved in the returned breakdown/reasons purely
// for narrative/explainability, per the "every BUY must explain" sprint
// requirement).
function computeConfidenceAdjustment({ ageMinutes, realtimePulse, syntheticBreakdown }){

    const pulse = resolvePulseAdjustment(realtimePulse);
    const tokenAge = resolveTokenAgeMultiplier(ageMinutes);
    const fakePump = resolveFakePumpPenalty({ realtimePulse, syntheticBreakdown });
    const kol = resolveKolAdjustment(realtimePulse);
    const smartMoney = resolveSmartMoneyAdjustment(realtimePulse);

    const combinedMultiplier = tokenAge.multiplier
        * (1 + pulse.pct / 100)
        * (1 + fakePump.pct / 100)
        * (1 + kol.pct / 100)
        * (1 + smartMoney.pct / 100);

    const reasons = [
        pulse.reason,
        tokenAge.reason,
        ...fakePump.reasons,
        kol.reason,
        smartMoney.reason
    ];

    return {
        pulse, tokenAge, fakePump, kol, smartMoney,
        combinedMultiplier,
        reasons
    };

}

// Applies the combined multiplier to a base confidence value (0-100),
// clamped to the same [0,100] bound confidence has always had in this
// codebase - not a new invented bound, the pre-existing one.
function applyToConfidence(baseConfidence, adjustment){
    if(baseConfidence == null) return baseConfidence;
    return Math.round(clamp(baseConfidence * adjustment.combinedMultiplier, 0, 100));
}

module.exports = {
    resolveTokenAgeMultiplier, resolveSmartMoneyAdjustment, resolveKolAdjustment, resolvePulseAdjustment, resolveFakePumpPenalty,
    computeConfidenceAdjustment, applyToConfidence, classifySeriesStrength
};
