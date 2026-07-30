// services/benchmarkRunService.js - Benchmark Harness Architecture
// Design Document section 5 (Runner Lifecycle). Owns the state machine
// (PENDING -> RUNNING <-> PAUSED -> STOPPED/COMPLETED) and duration
// tracking; delegates all trading logic to services/benchmarkRunner.js
// (never duplicates it) and all trade-close mechanics to the same
// services/tradeManager.js every other trading surface in this codebase
// uses.

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const benchmarkRunRepository = require("../repositories/benchmarkRunRepository");
const benchmarkProfileRepository = require("../repositories/benchmarkProfileRepository");
const benchmarkPositionRepository = require("../repositories/benchmarkPositionRepository");
const benchmarkStatisticsRepository = require("../repositories/benchmarkStatisticsRepository");
const benchmarkRunner = require("./benchmarkRunner");
const benchmarkReportService = require("./benchmarkReportService");
const { createTradeManager } = require("./tradeManager");
const retentionConfig = require("../config/retentionConfig");

function toSqliteTimestamp(date){
    return date.toISOString().slice(0, 19).replace("T", " ");
}

function parseSqliteTimestamp(ts){
    return new Date(`${String(ts).replace(" ", "T")}Z`).getTime();
}

function nowSqlite(){
    return toSqliteTimestamp(new Date());
}

function findActiveRuns(){
    return benchmarkRunRepository.findActiveRuns();
}

function getRunStatus(runId){
    const run = benchmarkRunRepository.findRunById(runId);
    if(!run) return null;
    return { ...run, participants: benchmarkRunRepository.findParticipantsByRun(runId) };
}

// ---- lifecycle transitions ----

function startRun({ name, plannedDurationSeconds, profileNames, marketDataNotes }){

    const errors = [];
    if(!name) errors.push("name is required.");
    if(!plannedDurationSeconds || plannedDurationSeconds < 60) errors.push("plannedDurationSeconds must be at least 60.");
    if(!Array.isArray(profileNames) || profileNames.length < 1) errors.push("At least one participant profile is required.");
    if(errors.length) return { ok: false, errors };

    const profiles = profileNames.map(n => benchmarkProfileRepository.findByName(n));
    const missing = profileNames.filter((n, i) => !profiles[i]);
    if(missing.length) return { ok: false, errors: [`Unknown benchmark profile(s): ${missing.join(", ")}`] };

    const run = benchmarkRunRepository.createRun({ name, plannedDurationSeconds, marketDataNotes });

    for(const profile of profiles){
        const config = JSON.parse(profile.config_json);
        benchmarkRunRepository.addParticipant({
            runId: run.id,
            profileId: profile.id,
            frozenConfigJson: profile.config_json,
            initialCapital: config.initial_capital ?? 100
        });
    }

    const activated = benchmarkRunRepository.updateRun(run.id, { status: "RUNNING", startedAt: nowSqlite() });

    return { ok: true, run: getRunStatus(activated.id) };

}

function pauseRun(runId){
    const run = benchmarkRunRepository.findRunById(runId);
    if(!run) return { ok: false, error: "Run not found." };
    if(run.status !== "RUNNING") return { ok: false, error: "Run is not RUNNING." };
    const updated = benchmarkRunRepository.updateRun(runId, { status: "PAUSED", pausedAt: nowSqlite() });
    return { ok: true, run: updated };
}

function resumeRun(runId){
    const run = benchmarkRunRepository.findRunById(runId);
    if(!run) return { ok: false, error: "Run not found." };
    if(run.status !== "PAUSED") return { ok: false, error: "Run is not PAUSED." };
    const pausedSeconds = Math.round((Date.now() - parseSqliteTimestamp(run.paused_at)) / 1000);
    const updated = benchmarkRunRepository.updateRun(runId, {
        status: "RUNNING",
        pausedAt: null,
        totalPausedSeconds: (run.total_paused_seconds || 0) + pausedSeconds
    });
    return { ok: true, run: updated };
}

function stopRun(runId){
    const run = benchmarkRunRepository.findRunById(runId);
    if(!run) return { ok: false, error: "Run not found." };
    if(!["RUNNING", "PAUSED"].includes(run.status)) return { ok: false, error: "Run is not active." };
    // Manual stop never auto-closes positions - fabricating an exit
    // reason for a manual stop would corrupt trade history's honesty
    // (architecture section 5). Positions are simply left OPEN/frozen.
    const updated = benchmarkRunRepository.updateRun(runId, { status: "STOPPED", stoppedAt: nowSqlite() });
    return { ok: true, run: updated };
}

function isDurationElapsed(run){
    if(!run.started_at) return false;
    const elapsedSeconds = (Date.now() - parseSqliteTimestamp(run.started_at)) / 1000 - (run.total_paused_seconds || 0);
    return elapsedSeconds >= run.planned_duration_seconds;
}

// Duration-based auto-completion (architecture section 5): unlike a
// manual stop, every remaining OPEN position IS closed here, at real
// current market price, reason BENCHMARK_DURATION_ENDED - every
// participant's capital must be fully realized at the same wall-clock
// boundary for Win Rate/Profit Factor to be comparable across them.
function completeRun(run){

    const participants = benchmarkRunRepository.findParticipantsByRun(run.id);
    const tokens = gmgnTokenRepository.getAllTokens();
    const byAddress = new Map(tokens.map(t => [t.token_address, t]));

    for(const participant of participants){
        const config = JSON.parse(participant.frozen_config_json);
        const repository = benchmarkPositionRepository.forParticipant(run.id, participant.id);
        const tradeManager = createTradeManager(repository);
        const openPositions = benchmarkPositionRepository.findOpenPositions(participant.id);
        for(const position of openPositions){
            const token = byAddress.get(position.token_address);
            const exitPrice = token && Number(token.price) > 0 ? Number(token.price) : (position.current_price || position.entry_price);
            tradeManager.finalizeClose(position, exitPrice, "BENCHMARK_DURATION_ENDED", config);
        }
    }

    benchmarkRunRepository.updateRun(run.id, { status: "COMPLETED", completedAt: nowSqlite() });

    // Automatic report generation (architecture section 5/7/8) - fires
    // exactly once, synchronously, on the COMPLETED transition.
    benchmarkReportService.generateReport(run.id);

    return { runId: run.id, completed: true, scanned: 0, participantResults: [] };

}

// Real equity snapshot for one participant - same formula
// services/tradingBotService.js's getPortfolio() already uses, scoped
// by run_participant_id via the aggregate helpers added alongside it
// in repositories/benchmarkPositionRepository.js.
function recordStatisticsSnapshot(runId, participantResult){
    const closedSums = benchmarkPositionRepository.sumClosedTrades(participantResult.runParticipantId);
    const openSums = benchmarkPositionRepository.sumOpenPositions(participantResult.runParticipantId);
    const availableCash = participantResult.initialCapital + closedSums.realizedPnl - openSums.openValueAtEntry;
    const equity = availableCash + openSums.openMarketValue;
    benchmarkStatisticsRepository.insertSnapshot({
        runId,
        runParticipantId: participantResult.runParticipantId,
        equity, availableCash,
        openPositionCount: openSums.openCount
    });
}

// Called by scheduler/benchmarkScheduler.js every tick for every
// active run. Never runs trading logic for a non-RUNNING run. Records
// one equity snapshot per participant per tick - the source of the
// live equity curve and the real (not estimated) max drawdown
// (architecture section 6/7).
async function processTick(runId){

    const run = benchmarkRunRepository.findRunById(runId);
    if(!run || run.status !== "RUNNING") return { skipped: true };

    if(isDurationElapsed(run)) return completeRun(run);

    const result = await benchmarkRunner.tick(runId);

    for(const participantResult of result.participantResults){
        recordStatisticsSnapshot(runId, participantResult);
    }

    return result;

}

// Automatic cleanup (architecture section 5): prunes raw
// benchmark_positions/trades/statistics for COMPLETED/STOPPED runs
// older than retentionConfig.benchmarkRawDataMaxAgeHours -
// benchmark_reports (the permanent research record) is never touched.
function pruneOldRunData(){

    const db = require("../database/connection");
    const cutoffIso = new Date(Date.now() - retentionConfig.benchmarkRawDataMaxAgeHours * 3600000).toISOString();
    const cutoff = toSqliteTimestamp(new Date(cutoffIso));

    const oldRuns = db.prepare(
        "SELECT id FROM benchmark_runs WHERE status IN ('COMPLETED','STOPPED') AND COALESCE(completed_at, stopped_at) < ?"
    ).all(cutoff);

    let positionsPruned = 0, tradesPruned = 0, statisticsPruned = 0, funnelSnapshotsPruned = 0, candidateSightingsPruned = 0;

    for(const run of oldRuns){
        positionsPruned += db.prepare("DELETE FROM benchmark_positions WHERE run_id = ?").run(run.id).changes;
        tradesPruned += db.prepare("DELETE FROM benchmark_trades WHERE run_id = ?").run(run.id).changes;
        statisticsPruned += db.prepare("DELETE FROM benchmark_statistics WHERE run_id = ?").run(run.id).changes;
        // Profile-Aware Production V2 refactor: same raw-data retention
        // policy as the tables above - benchmark_reports (the permanent
        // research record, which now includes the funnel/hindsight
        // numbers these raw tables fed) is never touched.
        funnelSnapshotsPruned += db.prepare("DELETE FROM benchmark_funnel_snapshots WHERE run_id = ?").run(run.id).changes;
        candidateSightingsPruned += db.prepare("DELETE FROM benchmark_candidate_sightings WHERE run_id = ?").run(run.id).changes;
    }

    return { runsAffected: oldRuns.length, positionsPruned, tradesPruned, statisticsPruned, funnelSnapshotsPruned, candidateSightingsPruned };

}

module.exports = {
    findActiveRuns, getRunStatus,
    startRun, pauseRun, resumeRun, stopRun,
    processTick, pruneOldRunData
};
