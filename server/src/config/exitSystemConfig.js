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
    emergencyMomentumHealthFloor: 25,

    // Give-back Profit Protection (exit-quality investigation,
    // 2026-08-07, real 234-position historical dataset, position-level
    // - not per-trade-row, since a TP1-split position's two rows must be
    // size-weighted blended, never counted as two independent trades).
    // Root cause traced from real positions: MOMENTUM_WEAKENING_EARLY_EXIT
    // (the only existing "trailing" mechanism) requires a real, confirmed
    // realtimePulse DOWN vote, which needs 2+ collector ticks (60s+) to
    // exist at all - and MAE_ACCELERATED_EXIT requires position.mae_pct
    // to ALREADY be negative and getting worse, so it structurally cannot
    // fire on the FIRST large pullback from a real peak. 12 real positions
    // (mfe_pct>15%, never reached TP1) fell through BOTH gaps and rode
    // a real profit (avg +20.4% peak) all the way down to a full Hard
    // Stop Loss (avg -45%/-16.5% final) - 10 of those 12 closed in under
    // 400 seconds, confirming the realtime-pulse warm-up gap specifically
    // (not a threshold-calibration issue).
    //
    // This is a NEW, price-only check (mirrors MAE_ACCELERATED_EXIT's own
    // already-approved pattern of never depending on realtimePulse/
    // contextStale, since the underlying price/mfe_pct reading is
    // trustworthy regardless of whether momentum classification is) -
    // fires when a position that has never reached TP1 gives back
    // maxGivebackPct points of ROI from its own real, already-tracked
    // mfe_pct peak.
    //
    // Deliberately scoped to PRE-TP1 positions only (tp1_hit_at IS NULL) -
    // Free Ride Mode's remaining 20% is deliberately built with NO
    // intermediate profit-protection floor (see tp2Pct's own header) so
    // it can genuinely ride to TP2; extending this check there would
    // defeat that design intent and was never part of the traced failure
    // (all 12 real positions this fixes were pre-TP1).
    //
    // minMfePct=15 reuses the SAME threshold MOMENTUM_WEAKENING_EARLY_EXIT
    // already uses (not a new number) - a position that never reached a
    // real +15% peak was never a "give-back" case as this file's own
    // Momentum Exit rule already defines that term.
    //
    // maxGivebackPct=10: grid-searched (5/8/10/12/15/20/25/30 points)
    // against the clean (non-TP1-split) 180-position historical subset.
    // 5pts backtested marginally better (WR 21.1% vs 21.1%, avgROI
    // -15.90% vs -16.37%) but was NOT chosen - the backtest can only see
    // each position's own final recorded mfe_pct/roi_pct (no persisted
    // tick-by-tick price history exists for held positions), so it cannot
    // distinguish "gave back G points and kept falling" from "dipped G
    // points, then pumped to an even higher real peak" - a tighter
    // threshold is more exposed to that blind spot. 10 keeps almost all
    // of the same backtested benefit (16 of 19 positions rescued at 5pts
    // are still rescued at 10pts) with more room against ordinary noise.
    givebackProtection: {
        minMfePct: 15,
        maxGivebackPct: 10
    }

};
