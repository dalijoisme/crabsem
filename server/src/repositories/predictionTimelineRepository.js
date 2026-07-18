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

module.exports = { insertSnapshot, findExistingHorizons, findByPrediction };
