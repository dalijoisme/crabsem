// config/realtimePulseConfig.js - Arjuna V4 Phase 2. Structural
// configuration for the Realtime Pulse layer ONLY - buffer shape, staleness
// bounds, retention. This file deliberately holds NO scoring weight,
// multiplier, confidence formula, or trading threshold - those are the
// Solution Architect's to define later (see services/realtimePulseService.js's
// own header for the explicit placeholder this file feeds).
//
// Every number below is either mandated directly by the sprint brief
// (BUFFER_SIZE) or reused from an already-established, already-proven
// convention elsewhere in this codebase (never invented fresh) - see each
// constant's own comment for its exact source.
//
// MAX_UNDERLYING_DATA_AGE_SECONDS is deliberately NOT duplicated here -
// config/ files in this codebase never require a service (services
// require config, not the reverse - see every other file in this
// directory). services/realtimePulseService.js reads
// entryGateService.MAX_MARKET_DATA_AGE_SECONDS directly instead, so there
// is exactly one real source for that number, never two independently-
// drifting copies.

module.exports = {

    // Sprint brief, explicit and non-negotiable: "The Pulse buffer remains
    // a rolling 3-point history. Do not expand to 5+ unless technically
    // required." See PHASE2_ARCHITECTURE_REVIEW.md Section 2 for the full
    // engineering justification (3 points is the minimum that supports
    // acceleration - a delta of deltas needs three readings - and the
    // minimum that can see a direction flip within the window; more points
    // trade responsiveness for smoothing, which this sprint explicitly
    // forbids trading away).
    BUFFER_SIZE: 3,

    // A buffered point older than this multiple of the nominal collector
    // interval (gmgnTrendingScheduler.INTERVAL_MS) is treated as stale -
    // never blindly used for a delta calculation, per the architecture
    // review's "unexpected polling delay" mitigation (Realtime Pulse must
    // never assume a fixed interval actually held). Reuses the same "3x an
    // established real cadence" convention already used in THREE other
    // places in this exact codebase (scheduler/tradingBotScheduler.js's
    // TICK_STUCK_AFTER_MS, scheduler/gmgnTrendingScheduler.js's own lock
    // guard watchdog multiplier, services/health.js's STALE_AFTER_SECONDS)
    // - not a new number invented for this file.
    STALE_POINT_INTERVAL_MULTIPLIER: 3

};
