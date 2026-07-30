// repositories/benchmarkStatisticsRepository.js - the only place that
// reads/writes benchmark_statistics (the periodic equity-curve
// snapshot). Same convention as abTestRepository's own
// ab_test_equity_snapshot handling - real max drawdown from a real
// recorded curve, never an estimate.

const db = require("../database/connection");

const insertSnapshotStmt = db.prepare(`
    INSERT INTO benchmark_statistics (run_id, run_participant_id, equity, available_cash, open_position_count)
    VALUES (@runId, @runParticipantId, @equity, @availableCash, @openPositionCount)
`);

function insertSnapshot({ runId, runParticipantId, equity, availableCash, openPositionCount }){
    insertSnapshotStmt.run({ runId, runParticipantId, equity, availableCash, openPositionCount });
}

function findEquityCurve(runParticipantId){
    return db.prepare(
        "SELECT equity, available_cash, open_position_count, taken_at FROM benchmark_statistics WHERE run_participant_id = ? ORDER BY taken_at ASC"
    ).all(runParticipantId);
}

function findLatestSnapshot(runParticipantId){
    return db.prepare(
        "SELECT * FROM benchmark_statistics WHERE run_participant_id = ? ORDER BY taken_at DESC LIMIT 1"
    ).get(runParticipantId);
}

// Real peak-to-trough drawdown from the real recorded equity curve -
// identical formula to abTestRepository.computeMaxDrawdownPct(), kept
// as its own small local implementation (5 lines) rather than a shared
// utility module - not worth the indirection for a formula this size.
function computeMaxDrawdownPct(runParticipantId){
    const curve = findEquityCurve(runParticipantId);
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

module.exports = { insertSnapshot, findEquityCurve, findLatestSnapshot, computeMaxDrawdownPct };
