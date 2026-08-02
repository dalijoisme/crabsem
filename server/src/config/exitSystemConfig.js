// config/exitSystemConfig.js - Arjuna V4 (Sprint 11), Part 3 - FINAL
// exit strategy, replacing Arjuna V3's TP1/Second-Target/Profit-Protection
// numbers wholesale (state machine mechanism unchanged, only the
// numbers/steps below). "Config owns the numbers, service owns the
// logic" convention, same as scoringConfig.js/momentumHealthConfig.js.

module.exports = {

    // Step 1 - Hard Stop Loss, computed fresh from the position's own
    // entry_price (not tradePlanService's separate dynamic 7-35% band,
    // which remains untouched for its own "AI Trade Plan" display
    // purpose). Unconditional - checked before TP1/Free Ride routing,
    // covers both the full pre-TP1 position and the post-TP1 remainder.
    hardStopLossPct: 20,

    // Step 2 - TP1: at +25% ROI, sell 80% of the position unconditionally.
    // "Target utama bukan memaksimalkan profit - target utama adalah
    // mengamankan modal": securing 80% of capital at the first real
    // target IS the capital-protection step.
    tp1: {
        triggerPct: 25,
        sellFraction: 0.8
    },

    // Step 3 - timer starts the moment TP1 fires.
    timerMinutes: 5,

    // Steps 4/5 - Free Ride Mode: the remaining 20% rides with no
    // intermediate profit-protection floor. TP2 at +100% sells the
    // entire remainder; otherwise the Step 3 timer (Time Exit) sells the
    // remainder unconditionally once it expires, regardless of the
    // remainder's ROI at that moment - a pure timer fallback, not
    // another profit floor (that would defeat "free ride").
    tp2Pct: 100,

    // Step 7 - Emergency Exit: Momentum Health remains ONLY an emergency
    // override (severe structural collapse - rug/liquidity collapse/
    // holder collapse/security issue), never the primary exit driver.
    // Reuses momentumHealthConfig.js's own hardBreakdownFloor - the same
    // conservative, multiple-signals-bad threshold already validated,
    // not a new number.
    emergencyMomentumHealthFloor: 25

};
