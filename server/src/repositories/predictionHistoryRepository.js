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
// sweep, which runs over every prediction still young enough that a
// configured horizon (config/predictionValidationConfig.js's
// timelineHorizons) might legitimately still be pending - a closed
// prediction can still have real, un-recorded timeline horizons between
// its creation and its close.
//
// SPRINT 12 (Arjuna V5) - ROOT CAUSE FIX for "Prediction Validation
// membutuhkan waktu sangat lama, run berikutnya selalu di-skip": this
// used to be an unbounded SELECT over the ENTIRE table, re-scanned every
// single 60s cycle, forever - a prediction older than the largest
// configured timeline horizon (24h) either already has every horizon
// recorded (reprocessing it is pure waste) or never will (its price-
// history source data has long since aged out of
// retentionConfig's own token_price_history window) - so re-including
// it in every cycle's scan is never productive, only ever expensive,
// and grows unboundedly with the table (699K+ rows and counting,
// per this account's own real data - retentionService.js does not
// prune prediction_history). Bounded by prediction_time (a real,
// already-indexed column - idx_prediction_history_prediction_time),
// this returns only predictions still young enough for at least one
// configured horizon to legitimately still be pending - a small,
// roughly-constant-size window instead of the whole table.
function findRecentLite(sinceTimestamp){

    return db.prepare("SELECT id, token_address, prediction_time FROM prediction_history WHERE prediction_time >= ?").all(sinceTimestamp);

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

// Batch version of "last N decision rows for this token" - one query
// for a whole cycle's worth of BUY Candidates instead of one query per
// token (services/opportunityPriorityService.js / services/emiService.js's
// shared batch context - Final Spec section 03/04: "batch read, tidak
// ada query per-token"). Window function keeps this a single query
// regardless of how many tokens are asked for. Returns a Map keyed by
// token_address -> rows ordered newest-first (row 0 = the same row
// token_last_decision already snapshots; row 1, if present, is the
// real prior decision needed to compute a delta).

function findRecentByTokens(tokenAddresses, limit = 2){

    const map = new Map();

    if(!tokenAddresses.length) return map;

    const CHUNK = 400;

    for(let i = 0; i < tokenAddresses.length; i += CHUNK){

        const chunk = tokenAddresses.slice(i, i + CHUNK);

        const placeholders = chunk.map(() => "?").join(",");

        const rows = db.prepare(`
            WITH ranked AS (
                SELECT id, token_address, prediction_time, recommendation, score, confidence, trigger_reason,
                       ROW_NUMBER() OVER (PARTITION BY token_address ORDER BY prediction_time DESC, id DESC) as rn
                FROM prediction_history
                WHERE token_address IN (${placeholders})
            )
            SELECT id, token_address, prediction_time, recommendation, score, confidence, trigger_reason
            FROM ranked WHERE rn <= ?
            ORDER BY token_address, rn ASC
        `).all(...chunk, limit);

        for(const row of rows){

            if(!map.has(row.token_address)) map.set(row.token_address, []);

            map.get(row.token_address).push(row);

        }

    }

    return map;

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

// Read-only, for the Benchmark Harness's hindsight report metrics
// (Opportunity Capture / False Negative / Recommendation Acceptance
// Rate - see services/benchmarkReportService.js). Returns each
// distinct token's EARLIEST BUY/STRONG BUY decision within
// [fromTimestamp, toTimestamp] (full-precision sqlite timestamps, not
// the date-only from/to buildWhereClause already supports) - this IS
// the single source of truth every participant's gate already reads
// (token_last_decision derives from the same table), never a second,
// separately-computed candidate list.
function findTradingTierInWindow(fromTimestamp, toTimestamp){
    return db.prepare(`
        SELECT token_address, token_symbol, prediction_time as first_seen_at, confidence, entry_price
        FROM prediction_history
        WHERE id IN (
            SELECT MIN(id) FROM prediction_history
            WHERE recommendation IN ('BUY','STRONG BUY') AND prediction_time BETWEEN ? AND ?
            GROUP BY token_address
        )
    `).all(fromTimestamp, toTimestamp);
}

// Retention (RATE_LIMIT_BANNED incident, 2026-08-05): this table had NO
// pruning at all since it was introduced (2026-07-20) - real evidence
// (see config/retentionConfig.js's predictionHistoryMaxAgeHours) traced
// an unbounded 135.8GB database, a 93%-full VPS disk, and a 139-second
// single synchronous query blocking the Node.js event loop long enough
// to cascade into the GMGN IP ban that stopped gmgn_tokens from ever
// refreshing. Excludes any row still referenced by trade_positions.
// opened_by_prediction_id (migration 017's real FK, foreign_keys=ON in
// database/connection.js) - a decision row that actually opened a real
// trade is permanent trade-audit history, never pruned by age alone,
// and deleting it while still referenced would throw a constraint
// violation anyway. Caller MUST prune predictionTimelineRepository's
// children for the same maxAgeHours FIRST (see that function's own
// comment) - this repository never reaches across tables itself.
//
// Deliberately a raw `prediction_time < @cutoff` comparison against a
// cutoff computed in JS (CURRENT_TIMESTAMP's own 'YYYY-MM-DD HH:MM:SS'
// UTC shape - directly comparable as text, no reformatting needed) -
// NOT `datetime(prediction_time) < datetime('now', ...)` like this
// codebase's other pruneOlderThan implementations. Verified via
// EXPLAIN QUERY PLAN on the real (135.8GB) production database:
// wrapping the column in datetime() defeats
// idx_prediction_history_prediction_time entirely (SCAN, full table),
// while this raw form uses it as a covering index (SEARCH) - the
// difference between a bounded index seek and a multi-minute full scan
// on the exact table this fix exists to stop from blocking the event
// loop. Every other table this codebase already prunes is small enough
// (24-48h retention) that this never mattered before.
//
// Batched + yielding, same pattern as services/predictionValidationService.js's
// own yieldToEventLoop()/EVENT_LOOP_YIELD_BATCH_SIZE (that file's own
// header documents the exact same failure mode this fix is closing:
// "measured, not hypothesized" 40-110+ second event-loop stalls from a
// single large synchronous query starving gmgn-scheduler's timers).
// Confirmed necessary by this very incident's OWN deploy: even after
// the historical backlog was cleared by hand, the routine catch-up
// (tens of thousands of rows accumulated during the outage) still took
// validation-scheduler 345 seconds as ONE unbatched DELETE, reproducing
// the identical stall on the very first run of this "fix". A small
// batch keeps every single synchronous chunk sub-second regardless of
// how large the backlog is, at the cost of this function no longer
// being synchronous.
const PRUNE_BATCH_SIZE = 200;

function yieldToEventLoop(){
    return new Promise(resolve => setImmediate(resolve));
}

const pruneOlderThanBatchStmt = db.prepare(`
    DELETE FROM prediction_history WHERE id IN (
        SELECT id FROM prediction_history
        WHERE prediction_time < @cutoff
          AND id NOT IN (SELECT opened_by_prediction_id FROM trade_positions)
        LIMIT @batch
    )
`);

async function pruneOlderThan(maxAgeHours){

    const cutoff = new Date(Date.now() - maxAgeHours * 3600000).toISOString().slice(0, 19).replace("T", " ");

    let total = 0;

    while(true){

        const info = pruneOlderThanBatchStmt.run({ cutoff, batch: PRUNE_BATCH_SIZE });
        total += info.changes;

        if(info.changes < PRUNE_BATCH_SIZE) break;

        await yieldToEventLoop();

    }

    return total;

}

module.exports = {

    insertPrediction,

    existsForToken,

    findOpen,

    findRecentLite,

    updateTracking,

    findById,

    findMany,

    countMany,

    countsByStatus,

    countsByRecommendation,

    findClosed,

    findClosedHold,

    findAllStatuses,

    findEarliestPredictionTime,

    findRecentByTokens,

    findTradingTierInWindow,

    pruneOlderThan

};
