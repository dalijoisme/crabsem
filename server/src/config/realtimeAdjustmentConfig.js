// config/realtimeAdjustmentConfig.js - Arjuna V4 FINAL DECISION ENGINE
// SPRINT. Every number in this file is the Solution Architect's own
// final, explicit production spec (not invented by implementation) -
// "config owns the numbers, service owns the logic" convention, same as
// exitSystemConfig.js/scoringConfig.js. See
// services/realtimeConfidenceAdjustmentService.js for how these combine.
//
// Governing constraint (Architect's own, non-negotiable): Realtime Pulse
// ONLY ever adjusts CONFIDENCE and RANKING - never the entry score,
// never the action tier, never a veto. Production V2's own unified
// entry score (services/researchEngineFactory.js's computeUnifiedEntryScore)
// is completely untouched by anything in this file.

module.exports = {

    // TOKEN AGE - a timing MULTIPLIER applied to confidence, never a
    // filter/gate (distinct from and additive to scoringConfig.js's own
    // existing ageBonus point-bonus on the entry score itself - that
    // mechanism is untouched). Upper-bound-exclusive except the last.
    tokenAgeMultiplier: [
        { maxMinutes: 10, multiplier: 0.95 },
        { maxMinutes: 60, multiplier: 1.00 },
        { maxMinutes: 180, multiplier: 0.90 },
        { maxMinutes: 360, multiplier: 0.75 },
        { maxMinutes: Infinity, multiplier: 0.60 }
    ],

    // REALTIME PULSE - the general momentum/flow signals (price,
    // liquidity, volume, buy/sell pressure, net flow - i.e. every
    // tracked series in realtimePulseService.js EXCEPT the smart-money/
    // KOL ones, which get their own dedicated sections below). Combined
    // adjustment to confidence, hard-capped both directions.
    pulse: {
        maxAdjustmentPct: 15
    },

    // SMART MONEY EVOLUTION - realtime flow (velocity/acceleration/
    // direction/consistency of smartMoneyNetUsd), not a static snapshot.
    // Three-bucket guideline, not a continuous curve - the Architect's
    // own explicit spec.
    smartMoney: {
        strongImprovingPct: 10,
        neutralPct: 0,
        clearlyWeakeningPct: -10
    },

    // KOL EVOLUTION - same philosophy/shape as Smart Money, applied to
    // kolNetUsd, own separate cap.
    kol: {
        strongImprovingPct: 8,
        neutralPct: 0,
        clearlyWeakeningPct: -8,
        maxAdjustmentPct: 8
    },

    // FAKE PUMP DETECTION - penalty only, never a hard veto (a genuine
    // security risk - honeypot/hard blacklist/critical illiquidity -
    // remains researchEngineFactory.js's existing, untouched safety
    // veto; this is a SEPARATE, softer confidence penalty layer).
    // Multiple categories may stack; combined penalty is capped.
    fakePump: {
        suspiciousPumpPct: -10,
        washTradingPct: -15,
        coordinatedActivityPct: -20,
        maxCombinedPenaltyPct: -25,
        // Detection thresholds reuse the ONE already-established
        // "how elevated is elevated" bound this codebase already uses
        // for orderflow-shaped signals (scoringConfig.js's own
        // entryScore.washTradingPenalty.confidenceThreshold, 70) -
        // applied here to the specific sub-groups of
        // syntheticMarketFilterService.js's existing breakdown that
        // correspond to each named category, rather than inventing a
        // second, independently-drifting threshold.
        elevatedThreshold: 70
    }

};
