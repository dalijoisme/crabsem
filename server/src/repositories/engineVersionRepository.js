// repositories/engineVersionRepository.js - the only place that
// reads/writes engine_version_history.

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO engine_version_history (
        version, notes, prediction_count_snapshot, win_rate_snapshot, avg_roi_snapshot
    ) VALUES (
        @version, @notes, @predictionCountSnapshot, @winRateSnapshot, @avgRoiSnapshot
    )
    ON CONFLICT(version) DO NOTHING
`);

function insertIfNew(row){

    const info = insertStmt.run(row);

    return info.changes > 0;

}

function existsForVersion(version){

    return Boolean(db.prepare("SELECT 1 FROM engine_version_history WHERE version = ?").get(version));

}

function findAll(){

    return db.prepare("SELECT * FROM engine_version_history ORDER BY deployed_at ASC").all();

}

module.exports = { insertIfNew, existsForVersion, findAll };
