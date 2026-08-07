// config/retentionConfig.js - how long append-only/time-series tables
// keep rows before pruning. See services/retentionService.js.
//
// gmgn_ondemand_cache is deliberately NOT pruned here: the
// Intelligence Engine reads it via getIgnoringExpiry() specifically
// because "stale-but-real data is still real data" (see that
// repository's own doc comment) - deleting old rows would turn real,
// honestly-aged signal into no signal at all. It's also small in
// practice (nothing proactively populates it - see the data-integrity
// audit), so it isn't a storage-growth risk today.

module.exports = {

    gmgnRawSnapshotsMaxAgeHours: 24,

    gmgnActivityFeedMaxAgeHours: 24 * 7,

    gmgnGasPriceMaxAgeHours: 24 * 7,

    // Must comfortably exceed the longest validation horizon (24h -
    // see config/validationConfig.js) plus slack for a delayed
    // evaluator run.
    tokenPriceHistoryMaxAgeHours: 48,

    // Benchmark Harness Architecture Design Document, "Automatic
    // cleanup": raw per-tick data (benchmark_positions/trades/statistics)
    // for COMPLETED/STOPPED runs older than this is pruned - the
    // distilled, permanent research record (benchmark_reports) is never
    // pruned, only the bulky row-level detail behind it.
    benchmarkRawDataMaxAgeHours: 24 * 14,

    // Arjuna V4 Phase 2 (Realtime Pulse) - same retention class as
    // tokenPriceHistoryMaxAgeHours above (a real per-token time series,
    // append-only). The in-memory rolling buffer
    // (services/realtimePulseBufferService.js) only ever needs the last
    // BUFFER_SIZE (3) real points per token for live computation - this
    // table exists for warm-start-after-restart, the Daily Trading
    // Review (needs "yesterday"'s data, same as tokenPriceHistoryMaxAgeHours's
    // own reasoning), and after-the-fact debugging. Set to the same 48h
    // (comfortably covers a full UTC day plus slack for a delayed Daily
    // Review run - this file's own established convention above, applied
    // to a new table rather than a fresh number).
    realtimePulseSnapshotsMaxAgeHours: 48,

    // Exit/entry engine optimization mission, Phase 5 (2026-08-07) -
    // token_decision_snapshots (migration 074), the decision-side
    // counterpart to realtime_pulse_snapshots above. Same retention class
    // and same reasoning - a real per-token time series, append-only,
    // needed for after-the-fact "how did confidence/participant score/
    // momentum phase evolve before this BUY" analysis over roughly the
    // last day or two, not indefinitely.
    tokenDecisionSnapshotsMaxAgeHours: 48,

    // RATE_LIMIT_BANNED incident (2026-08-05), real root cause: this
    // pair of tables (prediction_history - the AI Validation Framework's
    // append-only decision log, migration 017 - and its child
    // prediction_timeline) had NO retention at all since introduction
    // (2026-07-20), despite this file's own header already flagging
    // "nothing ever prunes" as the exact failure mode to guard against.
    // Real production evidence: evaluateAndRecordDecisions() created
    // 19,835 new prediction_history rows in a SINGLE ~1-minute cycle;
    // the live database grew from ~20GB to 135.8GB in 2 days and filled
    // the VPS disk to 93%. Once the table got that large, a single
    // synchronous better-sqlite3 call (recordTimelineSnapshots) took
    // 139 seconds, blocking the Node.js event loop long enough that
    // gmgn-scheduler's own 15s HTTP timeout fired 24s late (38988ms)
    // and its watchdog force-released a still in-flight lock -
    // overlapping/duplicate collector batches this produced are the
    // most likely reason GMGN's "IP is temporarily banned due to
    // repeated rate limit violations" ban never cleared.
    //
    // Must stay comfortably above the longest configured timeline
    // horizon (predictionValidationConfig.js's timelineHorizons, 24h)
    // plus slack, or recordTimelineSnapshots would never get a chance
    // to record a still-pending horizon before its parent row
    // disappeared. Set to the same 14-day class as
    // benchmarkRawDataMaxAgeHours above (raw per-decision detail,
    // already distilled separately into engine_daily_metrics by
    // learnService.recordDailySnapshot() - the permanent research
    // record, never pruned, same pattern as that file's own benchmark
    // reports).
    predictionHistoryMaxAgeHours: 24 * 14

};
