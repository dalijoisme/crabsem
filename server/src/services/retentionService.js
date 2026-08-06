// services/retentionService.js - keeps append-only/time-series
// tables bounded (see the production-readiness audit: "nothing ever
// prunes"). Every table pruned here has a structured, indexed
// replacement for anything a live feature actually depends on
// (token_price_history for price history, gmgn_activity_feed's own
// recent rows for smart-money/KOL scoring), so pruning old rows never
// removes data a current recommendation relies on.

const retentionConfig = require("../config/retentionConfig");
const gmgnSnapshotRepository = require("../repositories/gmgnSnapshotRepository");
const gmgnActivityFeedRepository = require("../repositories/gmgnActivityFeedRepository");
const gmgnGasPriceRepository = require("../repositories/gmgnGasPriceRepository");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");
// Arjuna V4 Phase 2 (Realtime Pulse) - same bounded-growth guarantee
// every other time-series table in this file already gets.
const realtimePulseRepository = require("../repositories/realtimePulseRepository");
// RATE_LIMIT_BANNED incident (2026-08-05) - see
// config/retentionConfig.js's predictionHistoryMaxAgeHours for the real
// production root-cause evidence this closes.
const predictionTimelineRepository = require("../repositories/predictionTimelineRepository");
const predictionHistoryRepository = require("../repositories/predictionHistoryRepository");

// async: predictionTimelineRepository/predictionHistoryRepository's own
// pruneOlderThan are batched + event-loop-yielding (see their own
// comments - a real production incident where the unbatched form
// blocked the event loop for minutes at a time on any nontrivial
// backlog). Every other prune below is already small enough (24-48h
// retention, proven fast) to stay synchronous.
async function pruneOldData(){

    // predictionTimelineRepository MUST run before predictionHistoryRepository,
    // same maxAgeHours - prediction_timeline.prediction_id is a real FK
    // to prediction_history(id) with foreign_keys=ON, so children have
    // to be gone before their parent row can be deleted.
    const predictionTimelinePruned = await predictionTimelineRepository.pruneForPredictionsOlderThan(retentionConfig.predictionHistoryMaxAgeHours);
    const predictionHistoryPruned = await predictionHistoryRepository.pruneOlderThan(retentionConfig.predictionHistoryMaxAgeHours);

    return {

        rawSnapshotsPruned: gmgnSnapshotRepository.pruneOlderThan(retentionConfig.gmgnRawSnapshotsMaxAgeHours),

        activityFeedPruned: gmgnActivityFeedRepository.pruneOlderThan(retentionConfig.gmgnActivityFeedMaxAgeHours),

        gasPricePruned: gmgnGasPriceRepository.pruneOlderThan(retentionConfig.gmgnGasPriceMaxAgeHours),

        priceHistoryPruned: tokenPriceHistoryRepository.pruneOlderThan(retentionConfig.tokenPriceHistoryMaxAgeHours),

        realtimePulseSnapshotsPruned: realtimePulseRepository.pruneOlderThan(retentionConfig.realtimePulseSnapshotsMaxAgeHours),

        predictionTimelinePruned,

        predictionHistoryPruned

    };

}

module.exports = { pruneOldData };
