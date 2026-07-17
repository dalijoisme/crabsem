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
        maxTargetPct: 60

    },

    stopLoss: {

        // Base stop distance, narrowed for HIGH risk (limit downside
        // faster) and widened when confidence is low (less certain,
        // so a tighter stop would just mean noise-driven exits).
        baseStopPct: 12,
        highRiskStopPct: 7,
        lowConfidenceWidenPct: 6,
        lowConfidenceThreshold: 35

    },

    // A logged action is only shown as a new "decision" in the
    // timeline if it differs from the previous logged action -
    // otherwise five-minute-interval logging noise would make the
    // timeline unreadable.
    timelineLimit: 40

};
