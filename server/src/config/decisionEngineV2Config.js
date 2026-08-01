// config/decisionEngineV2Config.js - Decision Engine V2 sprint. Every
// tunable number services/decisionEngineV2.js uses - no formula/threshold
// hardcoded inline in that file, same "config owns the numbers, service
// owns the logic" convention config/scoringConfig.js already established
// for the base Intelligence Engine.
//
// V2 does NOT replace or retune the base engine (config/scoringConfig.js,
// services/researchEngineFactory.js) - it consumes that engine's OWN
// already-computed signal (baseScore/action/reasons - see Layer 1's own
// "jangan diubah" requirement) as one INPUT among several, and blends it
// with real historical performance of this exact feature combination.

module.exports = {

    // =====================================
    // Layer 4 - confidence blend weights. Must sum to 1 (validated by
    // decisionEngineV2.js at call time, not silently renormalized -
    // a misconfigured sum is a real bug the caller should see, not a
    // number quietly fixed behind their back).
    // =====================================
    weights: {
        baseScore: 0.5,          // the base engine's own confidence (Layer 1, untouched)
        historicalWinRate: 0.3,  // this exact feature combination's real historical win rate
        expectedRoi: 0.2         // this exact feature combination's real historical avg ROI (mapped to a 0-100 score - see roiToScore below)
    },

    // =====================================
    // Sample-size gating (the "Penting" requirement): historical
    // influence must shrink to nothing as sample size shrinks, and go
    // to EXACTLY zero below a hard floor - never let a 2-trade sample
    // swing a live BUY/HOLD decision.
    // =====================================
    sampleGating: {
        // Below this sample size, historical data is ignored ENTIRELY -
        // sampleConfidenceFactor is forced to 0, Layer 5's win-rate/ROI
        // override rules never fire, and the final decision is a pure
        // passthrough of the base engine's own action/confidence
        // ("gunakan scoring lama").
        minSampleHardFloor: 5,

        // At/above this sample size, historical data is trusted at its
        // FULL configured weight (sampleConfidenceFactor = 1). Between
        // minSampleHardFloor and this value, sampleConfidenceFactor
        // ramps linearly from 0 to 1 - the weight that isn't yet
        // "earned" by sample size flows back onto baseScore (see
        // decisionEngineV2.js's computeConfidenceV2), never just
        // discarded.
        minReliableSampleSize: 20
    },

    // =====================================
    // Historical avg ROI (%, unbounded, can be negative) needs to be on
    // the same 0-100 scale as baseScore/historicalWinRate before it can
    // be blended in the same weighted sum. This is a deliberate,
    // explicit, configurable mapping - never an unstated assumption that
    // "ROI% already behaves like a 0-100 score".
    //   roiScore = clamp(50 + (roiPct - neutralRoiPct) / pctPerScorePoint, 0, 100)
    // Defaults: 0% ROI -> 50 (neutral), +50% ROI -> 100 (max), -50% ROI
    // -> 0 (min).
    // =====================================
    roiToScore: {
        neutralRoiPct: 0,
        pctPerScorePoint: 1
    },

    // =====================================
    // Layer 5 - decision override thresholds. Only ever evaluated when
    // sampleConfidenceFactor > 0 (i.e., real sample >= minSampleHardFloor)
    // - see the sample-gating section above.
    // =====================================
    decisionOverrides: {
        // Historical win rate below this caps the action at HOLD, even
        // if the base engine said BUY/STRONG BUY and confidenceV2 is
        // otherwise high.
        minWinRateForBuyPct: 40,

        // Historical average ROI below this ALSO caps the action at
        // HOLD ("Reject BUY" in the sprint's own spec) - independent of
        // the win-rate check, either one alone is enough to veto.
        minAvgRoiForBuyPct: 0
    },

    // Layer 2/3 - largest feature combination size looked up against
    // history. Matches server/scripts/audit-ai-performance.js's own
    // Section B (pairs + triplets) - kept in sync deliberately, not
    // coincidentally, via services/featureNormalizer.js's shared
    // getCombinationKeys().
    maxComboSize: 3

};
