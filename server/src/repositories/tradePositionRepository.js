// repositories/tradePositionRepository.js - real position lifecycle,
// split out of prediction_history (see migration 017 and
// predictionHistoryRepository.js's redesign comment). This is the ONLY
// place that opens/closes/tracks a real position. Never allows more
// than one OPEN position per token at once - enforced by both a real
// database partial unique index (idx_trade_positions_one_open_per_token)
// and a check here before attempting the insert, so callers get a clear
// JS-level answer instead of a raw SQLite constraint error.
//
// Every write here ALSO mirrors onto the linked prediction_history row
// (via predictionHistoryRepository.updateTracking) - this is the
// backward-compatibility bridge that keeps every existing
// status/mfe_pct/closed_at-based query in the rest of the app correct
// without having to rewrite each one immediately.

const db = require("../database/connection");
const predictionHistoryRepository = require("./predictionHistoryRepository");

const findOpenForTokenStmt = db.prepare("SELECT * FROM trade_positions WHERE token_address = ? AND status = 'OPEN'");
const findOpenStmt = db.prepare("SELECT * FROM trade_positions WHERE status = 'OPEN'");

function findOpenForToken(tokenAddress){
    return findOpenForTokenStmt.get(tokenAddress);
}

function findOpen(){
    return findOpenStmt.all();
}

const insertStmt = db.prepare(`
    INSERT INTO trade_positions (
        token_address, token_symbol, opened_by_prediction_id,
        entry_price, entry_market_cap, entry_liquidity, entry_volume, entry_holders,
        target_price, target_market_cap, stop_loss_price, stop_loss_market_cap, prediction_horizon_seconds,
        status, current_price, current_market_cap, current_roi_pct, mfe_pct, mae_pct, time_alive_seconds,
        last_checked_at
    ) VALUES (
        @tokenAddress, @tokenSymbol, @openedByPredictionId,
        @entryPrice, @entryMarketCap, @entryLiquidity, @entryVolume, @entryHolders,
        @targetPrice, @targetMarketCap, @stopLossPrice, @stopLossMarketCap, @predictionHorizonSeconds,
        'OPEN', @entryPrice, @entryMarketCap, 0, 0, 0, 0,
        CURRENT_TIMESTAMP
    )
`);

// Opens a new position for a token - REFUSES if one is already open
// (the real, database-enforced guarantee this whole redesign depends
// on). Also mirrors the linked prediction_history row's tracking
// columns to status='OPEN' so old position-shaped queries see it.
function openPosition(row){
    if(findOpenForToken(row.tokenAddress)){
        return { opened: false, reason: "A position is already OPEN for this token." };
    }

    const info = insertStmt.run(row);
    const positionId = info.lastInsertRowid;

    predictionHistoryRepository.updateTracking({
        id: row.openedByPredictionId,
        status: "OPEN",
        currentPrice: row.entryPrice,
        currentMarketCap: row.entryMarketCap,
        currentRoiPct: 0,
        mfePct: 0, maePct: 0, timeAliveSeconds: 0,
        closedAt: null, closeReason: null
    });

    return { opened: true, positionId };
}

const updateTrackingStmt = db.prepare(`
    UPDATE trade_positions SET
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

// Updates a position's tracking AND mirrors the same values onto its
// linked prediction_history row, so both tables always agree.
function updateTracking(position, tracking){
    updateTrackingStmt.run({ id: position.id, ...tracking });

    predictionHistoryRepository.updateTracking({
        id: position.opened_by_prediction_id,
        status: tracking.status,
        currentPrice: tracking.currentPrice,
        currentMarketCap: tracking.currentMarketCap,
        currentRoiPct: tracking.currentRoiPct,
        mfePct: tracking.mfePct,
        maePct: tracking.maePct,
        timeAliveSeconds: tracking.timeAliveSeconds,
        closedAt: tracking.closedAt,
        closeReason: tracking.closeReason
    });
}

// Closes an OPEN position early on a genuine signal reversal (see the
// architecture proposal's "Open Predictions" policy decision) - the
// ONLY reason a position closes before its own real TP/SL/EXPIRED
// outcome. Distinct close_reason so this is never confused with a real
// price-based TP/SL/EXPIRED close in analytics.
function closeOnSignalReversal(position, currentPrice, currentMarketCap){
    const roiPct = position.entry_price ? ((currentPrice / position.entry_price) - 1) * 100 : null;
    const tracking = {
        status: "SIGNAL_REVERSED",
        currentPrice, currentMarketCap, currentRoiPct: roiPct,
        mfePct: Math.max(position.mfe_pct || 0, roiPct ?? 0),
        maePct: Math.min(position.mae_pct || 0, roiPct ?? 0),
        timeAliveSeconds: Math.round((Date.now() - new Date(`${position.opened_at.replace(" ","T")}Z`).getTime()) / 1000),
        closedAt: new Date().toISOString().slice(0,19).replace("T"," "),
        closeReason: "Signal Reversed"
    };
    updateTracking(position, tracking);
}

module.exports = {
    findOpenForToken, findOpen,
    openPosition, updateTracking, closeOnSignalReversal
};
