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

function pruneOldData(){

    return {

        rawSnapshotsPruned: gmgnSnapshotRepository.pruneOlderThan(retentionConfig.gmgnRawSnapshotsMaxAgeHours),

        activityFeedPruned: gmgnActivityFeedRepository.pruneOlderThan(retentionConfig.gmgnActivityFeedMaxAgeHours),

        gasPricePruned: gmgnGasPriceRepository.pruneOlderThan(retentionConfig.gmgnGasPriceMaxAgeHours),

        priceHistoryPruned: tokenPriceHistoryRepository.pruneOlderThan(retentionConfig.tokenPriceHistoryMaxAgeHours)

    };

}

module.exports = { pruneOldData };
