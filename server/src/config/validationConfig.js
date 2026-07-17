// config/validationConfig.js - tunables for the recommendation
// validation framework (Sprint 2). Kept separate from
// scoringConfig.js because none of this affects what the Intelligence
// Engine recommends - it only affects how recommendations are
// recorded and later checked against real outcomes.

module.exports = {

    // How often recommendations are logged and due outcomes are
    // evaluated. Deliberately much coarser than the 30s GMGN collector
    // cadence - logging every 30s would make recommendation_log grow
    // ~17x faster than useful for backtesting (the recommendation
    // rarely changes tick-to-tick) and would cost real SQLite write
    // volume for no analytical benefit.
    intervalMs: 5 * 60 * 1000,

    horizons: [

        { label: "15m", seconds: 15 * 60 },
        { label: "30m", seconds: 30 * 60 },
        { label: "1h", seconds: 60 * 60 },
        { label: "4h", seconds: 4 * 60 * 60 },
        { label: "24h", seconds: 24 * 60 * 60 }

    ],

    // "Win" definitions - a deliberate, documented, first-pass
    // convention (see the engine-validation audit: this is a product
    // decision, not something that can be derived from the code).
    // Revisit once enough real recommendation_outcomes rows exist to
    // discuss with real numbers instead of guesses.
    winDefinition: {

        buyMinReturnPct: 0,          // STRONG BUY / BUY: win if price went up at all
        holdMinReturnPct: -10,       // HOLD: win if it didn't suffer a significant loss
        avoidMaxReturnPct: 0         // AVOID: win if price did NOT go up

    },

    // Metrics are only reported once a horizon has this many real
    // outcomes - below this, "50% win rate" is noise, not a signal.
    minSampleSizeForMetrics: 5

};
