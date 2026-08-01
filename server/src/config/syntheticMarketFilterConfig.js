// config/syntheticMarketFilterConfig.js - Arjuna vNext sprint. Every
// tunable number services/syntheticMarketFilterService.js uses - same
// "config owns the numbers, service owns the logic" convention
// config/scoringConfig.js and config/decisionEngineV2Config.js already
// establish.
//
// This is NOT a new quality gate - services/qualityGateService.js already
// hard-rejects on rug_ratio, top_10_holder_rate, bundler_mhr (combined
// with low liquidity), and serial-scam-creator pattern; none of those
// fields are re-used here. This filter looks at a DIFFERENT set of
// GMGN-computed orderflow/bot-behavior fields (already fetched into
// gmgn_trenches.raw_json by the existing trenches collector - zero new
// API calls) that qualityGateService never reads, specifically aimed at
// synthetic/wash-traded/bot-driven volume rather than structural rug risk.
//
// p99Ceiling values below are NOT guessed - derived from a real query
// against this account's own gmgn_trenches table (20,000 most recent
// rows with a real raw_json payload, 2026-08-02). Each field's own
// p99 percentile is used as the "clearly extreme" normalization ceiling,
// so a token sitting at the real-world 99th percentile for a signal
// scores that signal at 100/100 - not an arbitrary round number.
// is_wash_trading was true for 0 of the 20,000 rows sampled - real, but
// rare - kept as a hard override (never diluted into the weighted blend)
// for the moment it does fire, rather than relied on as the primary signal.

module.exports = {

    // Weighted composite - must sum to 1 (validated at call time,
    // same "a misconfigured sum is a real bug the caller should see"
    // convention decisionEngineV2Config.js's weights already use).
    weights: {
        botDegenRate: 0.20,               // repeated automated wallet behaviour
        bundlerTraderAmountRate: 0.20,     // coordinated/bundled order submission
        ratTraderAmountRate: 0.15,         // GMGN's own synthetic-volume-pattern trader metric
        entrapmentRatio: 0.15,             // GMGN's own manipulation-trap metric
        freshWalletRate: 0.10,             // one-off/throwaway wallets (sybil-adjacent)
        suspectedInsiderHoldRate: 0.10,    // insider-tagged concentration (distinct from top_10_holder_rate)
        holderToSwapDiversity: 0.05,       // derived: too few unique holders for the swap volume seen
        buySellClustering: 0.05            // derived: unnaturally balanced buy/sell split (round-trip wash pattern)
    },

    // Real p99 ceilings from the 20,000-row sample above - value/ceiling,
    // clamped to [0,1], is each field's own normalized 0-100 contribution.
    p99Ceiling: {
        botDegenRate: 0.60,
        bundlerTraderAmountRate: 0.50,
        ratTraderAmountRate: 0.08,
        entrapmentRatio: 0.32,
        freshWalletRate: 0.60,
        suspectedInsiderHoldRate: 0.08
    },

    // Derived signal #1 - holders/swaps_24h ratio. Real distribution
    // (swaps_24h >= minSwapsForDiversityCheck, 20,000-row sample):
    // p05=0.019, p50=0.094. A ratio at/below badRatioFloor scores 100
    // (bottom ~2-5% tail - abnormally few unique holders for the trade
    // volume, the wash-trading "same wallets churning" signature);
    // at/above healthyRatioCeiling scores 0 (at/above the real median -
    // genuinely nothing to flag). Never evaluated below
    // minSwapsForDiversityCheck - too little volume for the ratio to
    // mean anything, never fabricate suspicion from a thin sample.
    holderToSwapDiversity: {
        minSwapsForDiversityCheck: 20,
        badRatioFloor: 0.015,
        healthyRatioCeiling: 0.05
    },

    // Derived signal #2 - |buys_24h/(buys_24h+sells_24h) - 0.5|. Real
    // distribution (same sample): p05=0.0044, p10=0.012, p50=0.069.
    // Deliberately flags only an UNNATURALLY BALANCED 50/50 split at
    // real volume (the round-trip wash-trading signature: the same
    // actors buying and selling back and forth to fake volume) - never
    // a strong buy-side skew, which is exactly what a genuine momentum
    // candidate is expected to show and must never be penalized for
    // (Arjuna's entry philosophy is not touched by this filter).
    buySellClustering: {
        minTxForClusterCheck: 20,
        suspiciousBalanceBand: 0.02
    },

    // Composite score >= this rejects the candidate. Deliberately
    // conservative (roughly requires 2-3 signals simultaneously elevated,
    // not one noisy field) - an unvalidated starting point like every
    // other new threshold in this codebase's history (scoringConfig.js's
    // own actionTiers comment), meant to be re-checked once real
    // reject/pass outcomes accumulate, not a final calibrated number.
    rejectThreshold: 55

};
