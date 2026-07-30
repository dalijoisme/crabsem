// repositories/abTestRepository.js - the only file touching ab_test_*
// tables (Regular vs High Throughput comparison test). Every query is
// scoped by `profile` so the two portfolios never see or affect each
// other's rows despite sharing the same tables.

const db = require("../database/connection");

function getRun(){
    return db.prepare("SELECT * FROM ab_test_run WHERE id = 1").get();
}

function startRun(){
    db.prepare("UPDATE ab_test_run SET status = 'RUNNING', started_at = CURRENT_TIMESTAMP, stopped_at = NULL WHERE id = 1").run();
    return getRun();
}

function stopRun(){
    db.prepare("UPDATE ab_test_run SET status = 'STOPPED', stopped_at = CURRENT_TIMESTAMP WHERE id = 1").run();
    return getRun();
}

function findOpenPositions(profile){
    return db.prepare("SELECT * FROM ab_test_positions WHERE profile = ? AND status = 'OPEN' ORDER BY opened_at DESC").all(profile);
}

const findOpenPositionForTokenStmt = db.prepare(
    "SELECT * FROM ab_test_positions WHERE profile = ? AND token_address = ? AND status = 'OPEN'"
);

function findOpenPositionForToken(profile, tokenAddress){
    return findOpenPositionForTokenStmt.get(profile, tokenAddress);
}

const findLastTradeForTokenStmt = db.prepare(
    "SELECT * FROM ab_test_trades WHERE profile = ? AND token_address = ? ORDER BY closed_at DESC LIMIT 1"
);

function findLastTradeForToken(profile, tokenAddress){
    return findLastTradeForTokenStmt.get(profile, tokenAddress);
}

// Tournament-replica profile rule: "one entry per token, ever" - never
// re-enter regardless of outcome, matching run-validation-tournament.js's
// everOpenedAddresses set exactly. Checks BOTH still-open and
// already-closed rows for this token/profile.
function hasEverOpened(profile, tokenAddress){
    const row = db.prepare(
        "SELECT 1 FROM ab_test_positions WHERE profile = ? AND token_address = ? LIMIT 1"
    ).get(profile, tokenAddress);
    return Boolean(row);
}

const insertPositionStmt = db.prepare(`
    INSERT INTO ab_test_positions (
        profile, token_address, token_symbol, entry_price, current_price, size_usd,
        confidence, target_price, target_market_cap, stop_loss_price, stop_loss_market_cap,
        last_volume_1h, status
    ) VALUES (
        @profile, @tokenAddress, @tokenSymbol, @entryPrice, @entryPrice, @sizeUsd,
        @confidence, @targetPrice, @targetMarketCap, @stopLossPrice, @stopLossMarketCap,
        @lastVolume1h, 'OPEN'
    )
`);

function insertPosition(row){
    const info = insertPositionStmt.run({ lastVolume1h: null, ...row });
    return info.lastInsertRowid;
}

const updatePositionTrackingStmt = db.prepare(`
    UPDATE ab_test_positions SET current_price = @currentPrice, mfe_pct = @mfePct, mae_pct = @maePct, last_volume_1h = @lastVolume1h WHERE id = @id
`);

function updatePositionTracking(id, { currentPrice, mfePct, maePct, lastVolume1h }){
    updatePositionTrackingStmt.run({ id, currentPrice, mfePct, maePct, lastVolume1h: lastVolume1h ?? null });
}

const closePositionStmt = db.prepare(
    "UPDATE ab_test_positions SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = ?"
);

const insertTradeStmt = db.prepare(`
    INSERT INTO ab_test_trades (
        profile, token_address, token_symbol, entry_price, exit_price, size_usd,
        roi_pct, fee_usd, reason, opened_at, closed_at
    ) VALUES (
        @profile, @tokenAddress, @tokenSymbol, @entryPrice, @exitPrice, @sizeUsd,
        @roiPct, @feeUsd, @reason, @openedAt, CURRENT_TIMESTAMP
    )
`);

function closePosition(position, { exitPrice, roiPct, feeUsd, reason }){
    const tx = db.transaction(() => {
        closePositionStmt.run(position.id);
        insertTradeStmt.run({
            profile: position.profile,
            tokenAddress: position.token_address,
            tokenSymbol: position.token_symbol,
            entryPrice: position.entry_price,
            exitPrice, sizeUsd: position.size_usd, roiPct, feeUsd, reason,
            openedAt: position.opened_at
        });
    });
    tx();
}

function findTrades(profile){
    return db.prepare("SELECT * FROM ab_test_trades WHERE profile = ? ORDER BY closed_at ASC").all(profile);
}

function summarize(profile, initialCapital){

    const openPositions = findOpenPositions(profile);
    const trades = findTrades(profile);

    const openValueAtEntry = openPositions.reduce((s, p) => s + p.size_usd, 0);
    const openMarketValue = openPositions.reduce((s, p) => s + p.size_usd * ((p.current_price || p.entry_price) / p.entry_price), 0);

    const closedTrades = trades; // all rows in ab_test_trades are, by construction, closed
    const realizedPnl = closedTrades.reduce((s, t) => s + (t.size_usd * t.roi_pct / 100) - t.fee_usd, 0);
    const totalFees = closedTrades.reduce((s, t) => s + t.fee_usd, 0);

    const availableCash = initialCapital + realizedPnl - openValueAtEntry;
    const equity = availableCash + openMarketValue;

    const wins = closedTrades.filter(t => t.roi_pct > 0).length;
    const losses = closedTrades.filter(t => t.roi_pct <= 0).length;
    const tpCount = closedTrades.filter(t => t.reason === "TAKE_PROFIT").length;
    const slCount = closedTrades.filter(t => t.reason === "STOP_LOSS").length;
    const reversalCount = closedTrades.filter(t => t.reason === "SIGNAL_REVERSED").length;
    const rugCount = closedTrades.filter(t => (t.reason || "").startsWith("RUG_DETECTED")).length;

    return {
        profile,
        availableCash, equity, openValueAtEntry, openMarketValue,
        openCount: openPositions.length,
        closedCount: closedTrades.length,
        tpCount, slCount, reversalCount, rugCount,
        wins, losses,
        winRate: closedTrades.length ? (wins / closedTrades.length) * 100 : null,
        realizedPnl, totalFees,
        openPositions, trades
    };

}

const insertEquitySnapshotStmt = db.prepare(
    "INSERT INTO ab_test_equity_snapshot (profile, equity) VALUES (?, ?)"
);

function insertEquitySnapshot(profile, equity){
    insertEquitySnapshotStmt.run(profile, equity);
}

function findEquityCurve(profile){
    return db.prepare("SELECT equity, taken_at FROM ab_test_equity_snapshot WHERE profile = ? ORDER BY taken_at ASC").all(profile);
}

// Real max drawdown from the real equity curve - largest peak-to-
// trough drop observed, not a synthetic estimate.
function computeMaxDrawdownPct(profile){
    const curve = findEquityCurve(profile);
    if(curve.length < 2) return null;
    let peak = curve[0].equity;
    let maxDd = 0;
    for(const point of curve){
        peak = Math.max(peak, point.equity);
        const dd = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
        maxDd = Math.max(maxDd, dd);
    }
    return maxDd;
}

module.exports = {
    getRun, startRun, stopRun,
    findOpenPositions, findOpenPositionForToken, findLastTradeForToken, hasEverOpened,
    insertPosition, updatePositionTracking, closePosition,
    findTrades, summarize,
    insertEquitySnapshot, findEquityCurve, computeMaxDrawdownPct
};
