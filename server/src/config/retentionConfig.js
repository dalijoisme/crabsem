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
    realtimePulseSnapshotsMaxAgeHours: 48

};
