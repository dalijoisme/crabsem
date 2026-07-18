// repositories/predictionHistoryRepository.js - the only place that
// reads/writes prediction_history. The ENTRY/IMMUTABLE columns are
// only ever written by insertPrediction() (once, at creation); every
// other function here either reads, or writes ONLY the
// status/tracking columns via updateTracking() - never the entry
// columns. This split is what makes "immutable, never overwritten"
// a real guarantee instead of just a comment.

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO prediction_history (
        token_address, token_symbol, prediction_time,
        recommendation, score, confidence, reason_json,
        entry_price, entry_market_cap, entry_liquidity, entry_volume, entry_holders,
        wallet_summary_json, trade_plan_json,
        target_price, target_market_cap, stop_loss_price, stop_loss_market_cap,
        prediction_horizon_seconds,
        status, current_price, current_market_cap, current_roi_pct,
        mfe_pct, mae_pct, time_alive_seconds, last_checked_at
    ) VALUES (
        @tokenAddress, @tokenSymbol, CURRENT_TIMESTAMP,
        @recommendation, @score, @confidence, @reasonJson,
        @entryPrice, @entryMarketCap, @entryLiquidity, @entryVolume, @entryHolders,
        @walletSummaryJson, @tradePlanJson,
        @targetPrice, @targetMarketCap, @stopLossPrice, @stopLossMarketCap,
        @predictionHorizonSeconds,
        'OPEN', @entryPrice, @entryMarketCap, 0,
        0, 0, 0, CURRENT_TIMESTAMP
    )
    ON CONFLICT(token_address) DO NOTHING
`);

// Returns true if a new (immutable, first-ever) prediction was
// actually created for this token, false if one already existed -
// the UNIQUE(token_address) constraint is the real enforcement; this
// return value just tells the caller whether it did anything.

function insertPrediction(row){

    const info = insertStmt.run(row);

    return info.changes > 0;

}

function existsForToken(tokenAddress){

    return Boolean(db.prepare("SELECT 1 FROM prediction_history WHERE token_address = ?").get(tokenAddress));

}

function findOpen(){

    return db.prepare("SELECT * FROM prediction_history WHERE status = 'OPEN'").all();

}

// Lightweight rows (no large JSON blobs) for the per-minute timeline
// sweep, which runs over EVERY prediction (open or already closed) -
// a closed prediction can still have real, un-recorded timeline
// horizons between its creation and its close.

function findAllLite(){

    return db.prepare("SELECT id, token_address, prediction_time FROM prediction_history").all();

}

// The ONLY function permitted to UPDATE prediction_history - and it
// only ever lists tracking columns. Any future change here must never
// add an entry/immutable column to this SET list.

const updateTrackingStmt = db.prepare(`
    UPDATE prediction_history SET
        status = @status,
        current_price = @currentPrice,
        current_market_cap = @currentMarketCap,
        current_roi_pct = @currentRoiPct,
        mfe_pct = @mfePct,
        mae_pct = @maePct,
        time_alive_seconds = @timeAliveSeconds,
        closed_at = @closedAt,
        close_reason = @closeReason,
        last_checked_at = CURRENT_TIMESTAMP
    WHERE id = @id
`);

function updateTracking(tracking){

    updateTrackingStmt.run(tracking);

}

function findById(id){

    return db.prepare("SELECT * FROM prediction_history WHERE id = ?").get(id);

}

function findMany({ status, recommendation, limit = 50, offset = 0 } = {}){

    const clauses = [];

    const params = { limit, offset };

    if(status){ clauses.push("status = @status"); params.status = status; }

    if(recommendation){ clauses.push("recommendation = @recommendation"); params.recommendation = recommendation; }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    return db.prepare(`
        SELECT * FROM prediction_history
        ${where}
        ORDER BY prediction_time DESC
        LIMIT @limit OFFSET @offset
    `).all(params);

}

function countMany({ status, recommendation } = {}){

    const clauses = [];

    const params = {};

    if(status){ clauses.push("status = @status"); params.status = status; }

    if(recommendation){ clauses.push("recommendation = @recommendation"); params.recommendation = recommendation; }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    return db.prepare(`SELECT COUNT(*) as count FROM prediction_history ${where}`).get(params).count;

}

// Real aggregate counts by status - Part 4/5's headline numbers.

function countsByStatus({ recommendation } = {}){

    const where = recommendation ? "WHERE recommendation = @recommendation" : "";

    return db.prepare(`
        SELECT status, COUNT(*) as count FROM prediction_history
        ${where}
        GROUP BY status
    `).all(recommendation ? { recommendation } : {});

}

// Closed predictions (a real resolved outcome exists) - the only rows
// win-rate/ROI/timing statistics are computed from.

function findClosed({ recommendation } = {}){

    const where = recommendation

        ? "WHERE status != 'OPEN' AND recommendation = @recommendation"

        : "WHERE status != 'OPEN'";

    return db.prepare(`SELECT * FROM prediction_history ${where}`).all(recommendation ? { recommendation } : {});

}

module.exports = {

    insertPrediction,

    existsForToken,

    findOpen,

    findAllLite,

    updateTracking,

    findById,

    findMany,

    countMany,

    countsByStatus,

    findClosed

};
