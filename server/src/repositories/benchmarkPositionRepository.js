// repositories/benchmarkPositionRepository.js - the only place that
// reads/writes benchmark_positions and benchmark_trades. Every function
// is scoped by run_participant_id so two participants (even within the
// same run) never see or affect each other's state (Benchmark Harness
// Architecture Design Document section "Isolated Components").
//
// forParticipant(runId, runParticipantId) returns an object shaped
// EXACTLY like tradingBotRepository's own position/trade surface
// (insertPosition/updatePositionTracking/closePosition/insertLog/
// findOpenPositionForToken/findLastTradeForToken) - this is what lets
// services/tradeManager.js's createTradeManager() and
// services/entryGateService.js's createEntryGateService() run
// unmodified against a benchmark participant, never a second copy of
// their logic (architecture section 3).

const db = require("../database/connection");

function findOpenPositionForToken(runParticipantId, tokenAddress){
    return db.prepare(
        "SELECT * FROM benchmark_positions WHERE run_participant_id = ? AND token_address = ? AND status = 'OPEN'"
    ).get(runParticipantId, tokenAddress);
}

function findOpenPositions(runParticipantId){
    return db.prepare(
        "SELECT * FROM benchmark_positions WHERE run_participant_id = ? AND status = 'OPEN' ORDER BY opened_at DESC"
    ).all(runParticipantId);
}

// One query for every OPEN position across every participant in a run,
// grouped in memory by run_participant_id - the batch-fetch-once
// pattern the architecture's data flow (section 2, step 5) requires
// instead of one query per participant per cycle.
function findAllOpenPositionsForRun(runId){
    const rows = db.prepare(
        "SELECT * FROM benchmark_positions WHERE run_id = ? AND status = 'OPEN' ORDER BY opened_at DESC"
    ).all(runId);
    const byParticipant = new Map();
    for(const row of rows){
        if(!byParticipant.has(row.run_participant_id)) byParticipant.set(row.run_participant_id, []);
        byParticipant.get(row.run_participant_id).push(row);
    }
    return byParticipant;
}

function countOpenPositions(runParticipantId){
    return db.prepare(
        "SELECT COUNT(*) as c FROM benchmark_positions WHERE run_participant_id = ? AND status = 'OPEN'"
    ).get(runParticipantId).c;
}

function findLastTradeForToken(runParticipantId, tokenAddress){
    return db.prepare(
        "SELECT * FROM benchmark_trades WHERE run_participant_id = ? AND token_address = ? ORDER BY closed_at DESC LIMIT 1"
    ).get(runParticipantId, tokenAddress);
}

const insertPositionStmt = db.prepare(`
    INSERT INTO benchmark_positions (
        run_id, run_participant_id, token_address, token_symbol, entry_price, current_price, size_usd,
        confidence, exit_strategy, engine_version,
        target_price, target_market_cap, stop_loss_price, stop_loss_market_cap,
        last_volume_1h, decision_at, status
    ) VALUES (
        @runId, @runParticipantId, @tokenAddress, @tokenSymbol, @entryPrice, @entryPrice, @sizeUsd,
        @confidence, @exitStrategy, @engineVersion,
        @targetPrice, @targetMarketCap, @stopLossPrice, @stopLossMarketCap,
        @lastVolume1h, @decisionAt, 'OPEN'
    )
`);

function insertPosition(row){
    const info = insertPositionStmt.run({ lastVolume1h: null, decisionAt: null, ...row });
    return info.lastInsertRowid;
}

// Set once, right after a position opens - decision_at is the Signal
// Latency source (report section 7: "instrumented at write-time, not
// reconstructed after the fact"). Kept as a tiny separate write instead
// of a new parameter on tradeManager.openPosition() so that shared,
// reused module stays completely unaware of anything benchmark-specific.
const setDecisionAtStmt = db.prepare("UPDATE benchmark_positions SET decision_at = ? WHERE id = ?");

function setDecisionAt(positionId, decisionAt){
    if(!decisionAt) return;
    setDecisionAtStmt.run(decisionAt, positionId);
}

const updatePositionTrackingStmt = db.prepare(`
    UPDATE benchmark_positions
    SET current_price = @currentPrice, mfe_pct = @mfePct, mae_pct = @maePct, last_volume_1h = @lastVolume1h
    WHERE id = @id
`);

function updatePositionTracking(id, { currentPrice, mfePct, maePct, lastVolume1h }){
    updatePositionTrackingStmt.run({ id, currentPrice, mfePct, maePct, lastVolume1h: lastVolume1h ?? null });
}

const closePositionStmt = db.prepare(
    "UPDATE benchmark_positions SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = ?"
);

const insertTradeStmt = db.prepare(`
    INSERT INTO benchmark_trades (
        run_id, run_participant_id, token_address, token_symbol, entry_price, exit_price, size_usd,
        roi_pct, fee_usd, slippage_pct, duration_seconds, reason, opened_at, closed_at, decision_at
    ) VALUES (
        @runId, @runParticipantId, @tokenAddress, @tokenSymbol, @entryPrice, @exitPrice, @sizeUsd,
        @roiPct, @feeUsd, @slippagePct, @durationSeconds, @reason, @openedAt, CURRENT_TIMESTAMP, @decisionAt
    )
`);

function closePosition(position, { exitPrice, roiPct, feeUsd, slippagePct, durationSeconds, reason }){
    const tx = db.transaction(() => {
        closePositionStmt.run(position.id);
        insertTradeStmt.run({
            runId: position.run_id,
            decisionAt: position.decision_at ?? null,
            runParticipantId: position.run_participant_id,
            tokenAddress: position.token_address,
            tokenSymbol: position.token_symbol,
            entryPrice: position.entry_price,
            exitPrice, sizeUsd: position.size_usd, roiPct, feeUsd, slippagePct,
            durationSeconds, reason, openedAt: position.opened_at
        });
    });
    tx();
}

function findTrades(runParticipantId){
    return db.prepare("SELECT * FROM benchmark_trades WHERE run_participant_id = ? ORDER BY closed_at ASC").all(runParticipantId);
}

// Same aggregate shape as tradingBotRepository.sumClosedTrades()/
// sumOpenPositions() - scoped by run_participant_id, powers per-
// participant equity/portfolio computation without pulling every row
// into JS to sum.
// realizedPnl is NET of fees (matches abTestRepository.js's summarize(),
// the reference implementation this codebase already got right) -
// totalFees is still reported separately for transparency, but must
// never be added back into realizedPnl/availableCash/equity by a caller.
function sumClosedTrades(runParticipantId){
    return db.prepare(`
        SELECT
            COUNT(*) as closedCount,
            COALESCE(SUM(CASE WHEN roi_pct > 0 THEN 1 ELSE 0 END), 0) as winCount,
            COALESCE(SUM(CASE WHEN roi_pct <= 0 THEN 1 ELSE 0 END), 0) as lossCount,
            COALESCE(SUM((size_usd * roi_pct / 100.0) - fee_usd), 0) as realizedPnl,
            COALESCE(SUM(fee_usd), 0) as totalFees,
            COALESCE(SUM(CASE WHEN roi_pct > 0 THEN (size_usd * roi_pct / 100.0) ELSE 0 END), 0) as grossWin,
            COALESCE(SUM(CASE WHEN roi_pct <= 0 THEN ABS(size_usd * roi_pct / 100.0) ELSE 0 END), 0) as grossLoss
        FROM benchmark_trades
        WHERE run_participant_id = ? AND closed_at IS NOT NULL
    `).get(runParticipantId);
}

function sumOpenPositions(runParticipantId){
    return db.prepare(`
        SELECT
            COUNT(*) as openCount,
            COALESCE(SUM(size_usd), 0) as openValueAtEntry,
            COALESCE(SUM(size_usd * (COALESCE(current_price, entry_price) / entry_price)), 0) as openMarketValue
        FROM benchmark_positions
        WHERE run_participant_id = ? AND status = 'OPEN'
    `).get(runParticipantId);
}

// insertLog: benchmark runs are not user-facing simulations with their
// own live log feed (unlike trading_bot_log) - the architecture's 6
// named tables deliberately don't include one. tradeManager.js calls
// repository.insertLog() unconditionally after every open/close, so
// this satisfies that contract without adding an unspecified table.
function insertLog(entry){
    console.log(`[benchmark] ${entry.logType} ${entry.tokenSymbol || ""} - ${entry.message}`);
}

// The shared-shape view services/tradeManager.js and
// services/entryGateService.js actually consume - see file header.
function forParticipant(runId, runParticipantId){
    return {
        insertPosition: (row) => insertPosition({ ...row, runId, runParticipantId }),
        updatePositionTracking,
        closePosition,
        insertLog,
        findOpenPositionForToken: (tokenAddress) => findOpenPositionForToken(runParticipantId, tokenAddress),
        findLastTradeForToken: (tokenAddress) => findLastTradeForToken(runParticipantId, tokenAddress)
    };
}

module.exports = {
    findOpenPositionForToken, findOpenPositions, findAllOpenPositionsForRun, countOpenPositions,
    findLastTradeForToken, insertPosition, updatePositionTracking, closePosition, findTrades,
    sumClosedTrades, sumOpenPositions, setDecisionAt,
    forParticipant
};
