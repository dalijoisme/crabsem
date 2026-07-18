// config/predictionValidationConfig.js - tunables for the AI
// Validation Framework (engine-quality sprint 3). Kept separate from
// scoringConfig.js/tradePlanConfig.js because nothing here changes
// what the engine recommends - it only governs how a FIRST
// recommendation is tracked and evaluated against real outcomes.

module.exports = {

    schedulerIntervalMs: 60 * 1000,

    // A prediction with no real trade-plan-implied horizon falls back
    // to this (matches the longest horizon Sprint 2's validation
    // framework already uses, and retentionConfig's
    // tokenPriceHistoryMaxAgeHours=48 comfortably covers it with slack).
    defaultHorizonSeconds: 24 * 60 * 60,

    // Prediction Timeline snapshots (Part 8) - real recorded price at
    // or after each boundary, via tokenPriceHistoryRepository.
    // findPriceAtOrAfter() (same convention as outcomeEvaluatorService.js).
    timelineHorizons: [

        { label: "30m", seconds: 30 * 60 },
        { label: "1h", seconds: 60 * 60 },
        { label: "2h", seconds: 2 * 60 * 60 },
        { label: "4h", seconds: 4 * 60 * 60 },
        { label: "8h", seconds: 8 * 60 * 60 },
        { label: "24h", seconds: 24 * 60 * 60 }

    ],

    // Confidence Calibration buckets (Part 7).
    confidenceBuckets: [

        { min: 95, max: 100, label: "95-100" },
        { min: 90, max: 95, label: "90-95" },
        { min: 80, max: 90, label: "80-90" },
        { min: 70, max: 80, label: "70-80" },
        { min: 60, max: 70, label: "60-70" },
        { min: 0, max: 60, label: "<60" }

    ],

    // Failure Analysis (Part 6) - every threshold reads a real,
    // already-collected field (gmgn_trenches.net_buy_24h/
    // smart_degen_count, gmgn_tokens.liquidity/holders/price_change_1h/
    // raw_json.creator_close). Checked in this priority order; the
    // first real match wins - "Unknown" only when none of these real
    // signals explain the outcome. GMGN-only fields (creator_close)
    // simply never match for a DexScreener-sourced token - never
    // guessed, just not detected.

    failureAnalysis: {

        liquidityRemovedRatio: 0.5,       // current liquidity <= 50% of entry liquidity
        holderDeclineRatio: 0.85,         // current holders <= 85% of entry holders
        momentumCollapsePct: -30,         // price_change_1h at close <= this
        netDistributionUsd: -500          // gmgn_trenches.net_buy_24h at close <= this

    }

};
