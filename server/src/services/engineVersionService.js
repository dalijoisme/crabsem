// services/engineVersionService.js - Section 9 (Engine Improvement
// History). Real, append-only: a new row is recorded automatically
// the first time the server starts up running a version string it
// has never seen before (see config/engineVersion.js), snapshotting
// real prediction_history stats AT THAT MOMENT. No historical rows
// are invented for versions that shipped before this table existed -
// the version this sprint ships as is genuinely the first tracked one.

const engineVersion = require("../config/engineVersion");
const engineVersionRepository = require("../repositories/engineVersionRepository");
const predictionMetricsService = require("./predictionMetricsService");

function ensureCurrentVersionRecorded(){

    if(engineVersionRepository.existsForVersion(engineVersion.version)) return { recorded: false };

    const summary = predictionMetricsService.getSummary({});

    engineVersionRepository.insertIfNew({

        version: engineVersion.version,

        notes: engineVersion.notes,

        predictionCountSnapshot: summary.predictionCount,

        winRateSnapshot: summary.winRate,

        avgRoiSnapshot: summary.averageRoiPct

    });

    return { recorded: true };

}

// Real version-over-version deltas - "Improvement vs previous
// version" is only ever computed between two versions that both have
// a real recorded snapshot; the very first version has no prior row
// to compare against, so its delta fields are null, never zero.

function getHistory(){

    const rows = engineVersionRepository.findAll();

    return rows.map((row, i) => {

        const prev = rows[i - 1] || null;

        return {

            version: row.version,

            deployedAt: row.deployed_at,

            notes: row.notes,

            predictionCount: row.prediction_count_snapshot,

            winRate: row.win_rate_snapshot,

            averageRoiPct: row.avg_roi_snapshot,

            winRateDelta: prev && prev.win_rate_snapshot != null && row.win_rate_snapshot != null

                ? row.win_rate_snapshot - prev.win_rate_snapshot

                : null,

            averageRoiDelta: prev && prev.avg_roi_snapshot != null && row.avg_roi_snapshot != null

                ? row.avg_roi_snapshot - prev.avg_roi_snapshot

                : null

        };

    });

}

module.exports = { ensureCurrentVersionRecorded, getHistory };
