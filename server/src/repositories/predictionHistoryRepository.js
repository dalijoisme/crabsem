// repositories/predictionHistoryRepository.js - the only place that
// reads/writes prediction_history.
//
// PIPELINE REDESIGN (see server/src/services/predictionValidationService.js
// for the full picture): prediction_history is now a pure, append-only
// DECISION LOG - a token can receive as many rows as the trigger-rule
// engine decides are informative, never gated by "does a row already
// exist" (the old UNIQUE(token_address) constraint is gone - see
// migration 017). Position lifecycle (entry/target/stop/TP/SL/MFE/MAE)
// now lives in trade_positions (tradePositionRepository.js).
//
// BACKWARD COMPATIBILITY: every existing read function below
// (findOpen/findClosed/countsByStatus/etc.) is UNCHANGED and keeps
// working correctly, because tradePositionRepository.js mirrors its
// tracking updates back onto the ONE prediction_history row that
// actually opened a position (via updateTracking(), also unchanged).
// Decision rows that never open a position simply sit at
// status='DECISION_ONLY' and are invisible to those position-shaped
// queries, exactly as intended.

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO prediction_history (
        token_address, token_symbol, prediction_time,
        recommendation, score, confidence, reason_json,
        entry_price, entry_market_cap, entry_liquidity, entry_volume, entry_holders,
        wallet_summary_json, trade_plan_json,
        target_price, target_market_cap, stop_loss_price, stop_loss_market_cap,
        prediction_horizon_seconds,
        engine_version, engine_name, exit_strategy,
        trigger_reason, changed_from_recommendation, changed_from_confidence,
        status, current_price, current_market_cap, current_roi_pct,
        mfe_pct, mae_pct, time_alive_seconds, last_checked_at
    ) VALUES (
        @tokenAddress, @tokenSymbol, CURRENT_TIMESTAMP,
        @recommendation, @score, @confidence, @reasonJson,
        @entryPrice, @entryMarketCap, @entryLiquidity, @entryVolume, @entryHolders,
        @walletSummaryJson, @tradePlanJson,
        @targetPrice, @targetMarketCap, @stopLossPrice, @stopLossMarketCap,
        @predictionHorizonSeconds,
        @engineVersion, @engineName, @exitStrategy,
        @triggerReason, @changedFromRecommendation, @changedFromConfidence,
        @initialStatus, @entryPrice, @entryMarketCap, 0,
        0, 0, 0, CURRENT_TIMESTAMP
    )
`);

// ALWAYS inserts now (no ON CONFLICT DO NOTHING - the constraint that
// clause depended on no longer exists). Returns the new row's id so the
// caller can link a trade_positions row to it via
// opened_by_prediction_id, or record it as this token's newest decision
// in token_last_decision.
//
// `initialStatus` defaults to 'DECISION_ONLY' (a pure decision-log
// entry, no position opened) - the caller passes 'OPEN' explicitly only
// when this exact decision is also the one opening a real position.

function insertPrediction(row){

    const info = insertStmt.run({
        triggerReason: null,
        changedFromRecommendation: null,
        changedFromConfidence: null,
        initialStatus: "DECISION_ONLY",
        ...row
    });

    return info.lastInsertRowid;

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

// `tradingOnly` (Product Refinement Sprint - "HOLD and AVOID are not
// open positions") - restricts to recommendation IN ('STRONG BUY',
// 'BUY'), the only two tiers this engine ever opens a real position
// for. Win Rate / TP / SL / Open / ROI / holding-time queries must
// ALWAYS pass this; AVOID never has a row to filter in the first place
// (see tradePlanService.assessTradePlanReadiness - the readiness gate
// unconditionally rejects AVOID, so no trade plan and no
// prediction_history row is ever created for it), but HOLD DOES get a
// real trade plan/row when the gate passes - without this filter, a
// HOLD signal's real TP_HIT/SL_HIT outcome was being counted as if it
// were a trade, even though HOLD never opened a position.

const TRADING_TIERS = ["STRONG BUY", "BUY"];

// `excludeDecisionOnly` (pipeline redesign) - functions that predate
// the decision-log redesign assumed "every row is a position" (status
// one of OPEN/TP_HIT/SL_HIT/EXPIRED). Position-shaped stat functions
// (findClosed/findClosedHold/findAllStatuses/countsByStatus) pass this
// so new decision-only rows (status='DECISION_ONLY' - a recorded
// opinion that never opened a real position) never silently inflate
// Win Rate/Open Position counts. General browsing functions
// (findMany/countMany/countsByRecommendation) deliberately do NOT pass
// this - an admin browsing the decision timeline should see every
// decision, position-opening or not.

function buildWhereClause({ status, recommendation, tradingOnly, from, to, excludeDecisionOnly } = {}){

    const clauses = [];

    const params = {};

    if(excludeDecisionOnly) clauses.push("status != 'DECISION_ONLY'");

    if(status){ clauses.push("status = @status"); params.status = status; }

    if(recommendation){ clauses.push("recommendation = @recommendation"); params.recommendation = recommendation; }

    if(tradingOnly){ clauses.push(`recommendation IN (${TRADING_TIERS.map(t => `'${t}'`).join(",")})`); }

    // Plain string comparison, not datetime(prediction_time) - both
    // sides are already the exact same real "YYYY-MM-DD HH:MM:SS" text
    // SQLite's CURRENT_TIMESTAMP produces, so this is both correct AND
    // sargable (verified via EXPLAIN QUERY PLAN - wrapping the column
    // in datetime() made SQLite unable to use
    // idx_prediction_history_recommendation_time/_status_time at all,
    // silently falling back to the single-column index and scanning
    // every row in that name/status instead of range-seeking by date).

    if(from){ clauses.push("prediction_time >= @from"); params.from = `${from} 00:00:00`; }

    if(to){ clauses.push("prediction_time <= @to"); params.to = `${to} 23:59:59`; }

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

function countsByStatus({ recommendation, tradingOnly, from, to } = {}){

    const { where, params } = buildWhereClause({ recommendation, tradingOnly, from, to, excludeDecisionOnly: true });

    return db.prepare(`
        SELECT status, COUNT(*) as count FROM prediction_history
        ${where}
        GROUP BY status
    `).all(params);

}

// Real aggregate counts by recommendation tier - CEO Dashboard
// Section 3 (Signal Summary).

function countsByRecommendation({ from, to } = {}){

    const { where, params } = buildWhereClause({ from, to });

    return db.prepare(`
        SELECT recommendation, COUNT(*) as count FROM prediction_history
        ${where}
        GROUP BY recommendation
    `).all(params);

}

// Closed predictions (a real resolved outcome exists) - the only rows
// win-rate/ROI/timing statistics are computed from.

// Real earliest prediction_time in the whole table (Product
// Improvement Sprint's AI Dashboard/Learn System) - used to decide
// whether a "last 7 days" or "day-over-day" comparison has enough real
// history behind it yet, instead of silently comparing two windows
// where one is mostly/entirely empty and calling it a real trend.

function findEarliestPredictionTime(){

    return db.prepare("SELECT MIN(prediction_time) as earliest FROM prediction_history").get().earliest;

}

// Every status (OPEN included), same real filter as findClosed - Admin
// V3.1's Confidence Calibration fix (Part 9) needs real Expired/Open
// counts per confidence band alongside TP/SL, which findClosed()
// deliberately excludes.

function findAllStatuses({ recommendation, tradingOnly, from, to } = {}){

    const { where, params } = buildWhereClause({ status: undefined, recommendation, tradingOnly, from, to, excludeDecisionOnly: true });

    return db.prepare(`SELECT * FROM prediction_history ${where}`).all(params);

}

function findClosed({ recommendation, tradingOnly, from, to } = {}){

    const { where, params } = buildWhereClause({ status: undefined, recommendation, tradingOnly, from, to, excludeDecisionOnly: true });

    // findClosed always means "not OPEN" - folded in here rather than
    // via buildWhereClause's single-value `status` param, since this
    // is a negative/multi-value condition, not an equality filter.
    const clauses = [where.replace(/^WHERE /, "") || null, "status != 'OPEN'"].filter(Boolean);

    return db.prepare(`SELECT * FROM prediction_history WHERE ${clauses.join(" AND ")}`).all(params);

}

// HOLD-tier closed predictions (Product Refinement Sprint - HOLD gets
// its own real evaluation instead of being folded into trading
// stats). HOLD DOES get a real trade plan/row when the readiness gate
// passes (unlike AVOID, which never does), so this is real, trackable
// data - just evaluated under a different question ("was holding
// correct?") than BUY/STRONG BUY's ("did the trade win?").

function findClosedHold({ from, to } = {}){

    const { where, params } = buildWhereClause({ status: undefined, recommendation: "HOLD", from, to, excludeDecisionOnly: true });

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

    countsByRecommendation,

    findClosed,

    findClosedHold,

    findAllStatuses,

    findEarliestPredictionTime

};
