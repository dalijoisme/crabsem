// repositories/benchmarkRunRepository.js - the only place that
// reads/writes benchmark_runs and benchmark_run_participants. A
// participant's frozen_config_json is written ONCE, at addParticipant()
// time, from a caller-supplied snapshot of benchmark_profiles.config_json -
// this repository never re-reads the live preset, which is what makes
// a run reproducible even if the preset is edited afterward (Benchmark
// Harness Architecture Design Document section 4/9).

const db = require("../database/connection");

function findRunById(id){
    return db.prepare("SELECT * FROM benchmark_runs WHERE id = ?").get(id);
}

function findAllRuns(){
    return db.prepare("SELECT * FROM benchmark_runs ORDER BY created_at DESC").all();
}

function findActiveRuns(){
    return db.prepare("SELECT * FROM benchmark_runs WHERE status IN ('RUNNING','PAUSED')").all();
}

const insertRunStmt = db.prepare(`
    INSERT INTO benchmark_runs (name, status, planned_duration_seconds, market_data_notes)
    VALUES (@name, 'PENDING', @plannedDurationSeconds, @marketDataNotes)
`);

function createRun({ name, plannedDurationSeconds, marketDataNotes }){
    const info = insertRunStmt.run({ name, plannedDurationSeconds, marketDataNotes: marketDataNotes ?? null });
    return findRunById(info.lastInsertRowid);
}

const updateRunStmt = db.prepare(`
    UPDATE benchmark_runs SET
        status = @status,
        total_paused_seconds = @totalPausedSeconds,
        started_at = @startedAt,
        paused_at = @pausedAt,
        stopped_at = @stoppedAt,
        completed_at = @completedAt
    WHERE id = @id
`);

// Partial update - any field left undefined keeps its current DB value,
// matching the merge convention already used by tradingBotRepository.updateConfig.
function updateRun(id, patch){
    const current = findRunById(id);
    const merged = {
        id,
        status: patch.status ?? current.status,
        totalPausedSeconds: patch.totalPausedSeconds ?? current.total_paused_seconds,
        startedAt: patch.startedAt ?? current.started_at,
        pausedAt: patch.pausedAt ?? current.paused_at,
        stoppedAt: patch.stoppedAt ?? current.stopped_at,
        completedAt: patch.completedAt ?? current.completed_at
    };
    updateRunStmt.run(merged);
    return findRunById(id);
}

const insertParticipantStmt = db.prepare(`
    INSERT INTO benchmark_run_participants (run_id, profile_id, frozen_config_json, initial_capital)
    VALUES (@runId, @profileId, @frozenConfigJson, @initialCapital)
`);

function addParticipant({ runId, profileId, frozenConfigJson, initialCapital }){
    const info = insertParticipantStmt.run({ runId, profileId, frozenConfigJson, initialCapital });
    return findParticipantById(info.lastInsertRowid);
}

function findParticipantById(id){
    return db.prepare(`
        SELECT rp.*, p.name as profile_name
        FROM benchmark_run_participants rp
        JOIN benchmark_profiles p ON p.id = rp.profile_id
        WHERE rp.id = ?
    `).get(id);
}

function findParticipantsByRun(runId){
    return db.prepare(`
        SELECT rp.*, p.name as profile_name
        FROM benchmark_run_participants rp
        JOIN benchmark_profiles p ON p.id = rp.profile_id
        WHERE rp.run_id = ?
        ORDER BY rp.id ASC
    `).all(runId);
}

module.exports = {
    findRunById, findAllRuns, findActiveRuns, createRun, updateRun,
    addParticipant, findParticipantById, findParticipantsByRun
};
