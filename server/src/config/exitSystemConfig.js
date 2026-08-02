// config/exitSystemConfig.js - Arjuna V3 (FINAL SPRINT), Part 10. Every
// number the new deterministic exit state machine
// (services/dynamicExitService.js) uses - "config owns the numbers,
// service owns the logic" convention, same as scoringConfig.js/
// momentumHealthConfig.js. Exit is now deterministic, not a discussion -
// these are the exact numbers from the final spec, not tuned/guessed.

module.exports = {

    // Step 1 - Hard Stop Loss, computed fresh from the position's own
    // entry_price (not tradePlanService's separate dynamic 7-35% band,
    // which remains untouched for its own "AI Trade Plan" display
    // purpose) - the new deterministic system's own floor.
    hardStopLossPct: 20,

    // Step 2 - Take Profit 1: at +25% ROI, sell 50% of the position
    // unconditionally.
    tp1: {
        triggerPct: 25,
        sellFraction: 0.5
    },

    // Step 3 - timer starts the moment TP1 fires.
    timerMinutes: 5,

    // Step 4 - Second Target: if the REMAINING position reaches +50%
    // ROI (same entry_price basis), sell everything left.
    secondTargetPct: 50,

    // Step 5 - Time Exit: if the 5-minute timer expires and price never
    // reached +40% ROI (checked against the position's own real mfe_pct,
    // the highest ROI actually reached), sell the remaining position.
    timeExitRequiredPct: 40,

    // Step 6 - Profit Protection: after TP1, if remaining profit drops
    // below +15%, sell immediately. No trailing, no waiting.
    profitProtectionFloorPct: 15,

    // Step 7 - Emergency Exit: Momentum Health is now ONLY an emergency
    // override (severe structural collapse), never the primary exit
    // driver. Reuses momentumHealthConfig.js's own hardBreakdownFloor -
    // the same conservative, multiple-signals-bad threshold already
    // validated in the previous sprint, not a new number.
    emergencyMomentumHealthFloor: 25

};
