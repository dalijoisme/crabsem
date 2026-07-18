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

// Shared WHERE-clause builder (UX sprint's Admin Date Filter, Part 2) -
// every read function below accepts the same optional { status,
// recommendation, from, to } filter, `from`/`to` being real
// "YYYY-MM-DD" boundary dates compared against the real, immutable
// prediction_time column (never a guessed/derived date). Both bounds
// are inclusive; `to` is extended to the end of that calendar day so
// "today" actually includes all of today, not just 00:00:00.

function buildWhereClause({ status, recommendation, from, to } = {}){

    const clauses = [];

    const params = {};

    if(status){ clauses.push("status = @status"); params.status = status; }

    if(recommendation){ clauses.push("recommendation = @recommendation"); params.recommendation = recommendation; }

    if(from){ clauses.push("datetime(prediction_time) >= datetime(@from)"); params.from = `${from} 00:00:00`; }

    if(to){ clauses.push("datetime(prediction_time) <= datetime(@to)"); params.to = `${to} 23:59:59`; }

    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };

}

function findMany({ status, recommendation, from, to, limit = 50, offset = 0 } = {}){

    const { where, params } = buildWhereClause({ status, recommendation, from, to });

    return db.prepare(`
        SELECT * FROM prediction_history
        ${where}
        ORDER BY prediction_time DESC
        LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });

}

function countMany({ status, recommendation, from, to } = {}){

    const { where, params } = buildWhereClause({ status, recommendation, from, to });

    return db.prepare(`SELECT COUNT(*) as count FROM prediction_history ${where}`).get(params).count;

}

// Real aggregate counts by status - Part 4/5's headline numbers.

function countsByStatus({ recommendation, from, to } = {}){

    const { where, params } = buildWhereClause({ recommendation, from, to });

    return db.prepare(`
        SELECT status, COUNT(*) as count FROM prediction_history
        ${where}
        GROUP BY status
    `).all(params);

}

// Closed predictions (a real resolved outcome exists) - the only rows
// win-rate/ROI/timing statistics are computed from.

function findClosed({ recommendation, from, to } = {}){

    const { where, params } = buildWhereClause({ status: undefined, recommendation, from, to });

    // findClosed always means "not OPEN" - folded in here rather than
    // via buildWhereClause's single-value `status` param, since this
    // is a negative/multi-value condition, not an equality filter.
    const clauses = [where.replace(/^WHERE /, "") || null, "status != 'OPEN'"].filter(Boolean);

    return db.prepare(`SELECT * FROM prediction_history WHERE ${clauses.join(" AND ")}`).all(params);

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
