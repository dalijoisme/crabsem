// config/tradePlanConfig.js - tunables for the AI Trade Plan's
// entry-zone/target/stop bands. These are transparent, formula-driven
// heuristic guidance derived from real, already-computed engine
// output (price, confidence, risk, participant score) - the same
// kind of documented heuristic the earliness curve in
// scoringConfig.js already is. They are NOT a price forecast and
// never claim to be - see services/tradePlanService.js.

module.exports = {

    entryZone: {

        minBandPct: 2,
        maxBandPct: 15,

        // Entry-zone width scales with recent 1h momentum - a token
        // already moving fast gets a wider real-world entry band.
        momentumScaleFactor: 0.12

    },

    target: {

        // Target % scales linearly with Participant Score (0-100) up
        // to this cap - a heuristic proportional to conviction, not a
        // predicted price.
        maxTargetPct: 60,

        // Trend-aware discount (engine-quality sprint): participant
        // score alone doesn't know which way the chart is moving
        // right now - projecting a full upside target while the token
        // is in a real, currently-observed downtrend is exactly the
        // "misleading number" this sprint exists to remove. A real
        // change1h at/below this threshold discounts the projected
        // target instead of ignoring direction entirely.
        downtrendPct: -10,
        downtrendTargetFactor: 0.5

    },

    stopLoss: {

        // Base stop distance, narrowed for HIGH risk (limit downside
        // faster) and widened when confidence is low (less certain,
        // so a tighter stop would just mean noise-driven exits).
        baseStopPct: 12,
        highRiskStopPct: 7,
        lowConfidenceWidenPct: 6,
        lowConfidenceThreshold: 35,

        // Real liquidity/volume-aware widening (engine-quality
        // sprint): thin real liquidity or thin real trading activity
        // means higher real slippage/execution risk on both entry and
        // exit, independent of the engine's own risk label - a stop
        // this tight is more likely to be noise-triggered on a token
        // that can't actually be traded near the plan's own numbers.
        lowLiquidityUsdThreshold: 10000,
        lowLiquidityWidenPct: 5,
        lowVolumeRatioThreshold: 0.05,
        lowVolumeWidenPct: 4,
        maxStopPct: 35

    },

    // Trade Plan READINESS gate (engine-quality sprint): "waiting for
    // confirmation" instead of a numeric plan when real evidence is
    // too thin or the recommendation itself says to avoid the token -
    // a projected Entry/Target/Stop on an AVOID token, or one built
    // almost entirely from neutral/no-data placeholders, is not a
    // heuristic, it is a misleading number. See tradePlanService.js's
    // assessTradePlanReadiness().

    readiness: {

        minConfidence: 30,
        minParticipantModulesWithData: 2

    },

    // A logged action is only shown as a new "decision" in the
    // timeline if it differs from the previous logged action -
    // otherwise five-minute-interval logging noise would make the
    // timeline unreadable.
    timelineLimit: 40

};
