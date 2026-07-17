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
    tokenPriceHistoryMaxAgeHours: 48

};
