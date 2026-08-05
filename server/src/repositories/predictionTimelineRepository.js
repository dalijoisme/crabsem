// repositories/predictionTimelineRepository.js - the only place that
// reads/writes prediction_timeline (Part 8 - the learning dataset:
// real ROI/MC/price at 30m/1h/2h/4h/8h/24h after each prediction).

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO prediction_timeline (prediction_id, horizon, roi_pct, market_cap, price)
    VALUES (@predictionId, @horizon, @roiPct, @marketCap, @price)
    ON CONFLICT(prediction_id, horizon) DO NOTHING
`);

function insertSnapshot(row){

    const info = insertStmt.run(row);

    return info.changes > 0;

}

function findExistingHorizons(predictionId){

    return new Set(

        db.prepare("SELECT horizon FROM prediction_timeline WHERE prediction_id = ?")
            .all(predictionId)
            .map(r => r.horizon)

    );

}

function findByPrediction(predictionId){

    return db.prepare(`
        SELECT horizon, recorded_at, roi_pct, market_cap, price
        FROM prediction_timeline
        WHERE prediction_id = ?
        ORDER BY recorded_at ASC
    `).all(predictionId);

}

// Retention (RATE_LIMIT_BANNED incident, 2026-08-05 - see
// config/retentionConfig.js's predictionHistoryMaxAgeHours for the full
// real-production root-cause writeup): MUST run before
// predictionHistoryRepository.pruneOlderThan() with the SAME
// maxAgeHours - prediction_timeline.prediction_id is a real FK to
// prediction_history(id) and this database runs with
// foreign_keys=ON (database/connection.js), so a parent row can never
// be deleted while a child here still references it. Targets the exact
// same row-set predictionHistoryRepository.pruneOlderThan() is about to
// delete (by the PARENT's own prediction_time, not this table's own
// recorded_at - a 24h-horizon snapshot can be recorded up to a day
// after its parent, so pruning by this table's own timestamp could
// leave a fresh-looking child pointing at an already-deleted parent).
function pruneForPredictionsOlderThan(maxAgeHours){

    const info = db.prepare(`
        DELETE FROM prediction_timeline
        WHERE prediction_id IN (
            SELECT id FROM prediction_history
            WHERE datetime(prediction_time) < datetime('now', '-' || ? || ' hours')
        )
    `).run(maxAgeHours);

    return info.changes;

}

module.exports = { insertSnapshot, findExistingHorizons, findByPrediction, pruneForPredictionsOlderThan };
