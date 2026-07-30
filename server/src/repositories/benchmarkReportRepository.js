// repositories/benchmarkReportRepository.js - the only place that
// reads/writes benchmark_reports. One row per (run_id,
// run_participant_id) - upsertReport overwrites in place so a
// mid-run "standings so far" preview and the final report share the
// same row/shape, distinguished only by is_final.

const db = require("../database/connection");

const upsertStmt = db.prepare(`
    INSERT INTO benchmark_reports (run_id, run_participant_id, rank, metrics_json, is_final)
    VALUES (@runId, @runParticipantId, @rank, @metricsJson, @isFinal)
    ON CONFLICT(run_id, run_participant_id) DO UPDATE SET
        generated_at = CURRENT_TIMESTAMP,
        rank = excluded.rank,
        metrics_json = excluded.metrics_json,
        is_final = excluded.is_final
`);

function upsertReport({ runId, runParticipantId, rank, metricsJson, isFinal }){
    upsertStmt.run({ runId, runParticipantId, rank: rank ?? null, metricsJson, isFinal: isFinal ? 1 : 0 });
}

function findReportsByRun(runId){
    return db.prepare(`
        SELECT r.*, rp.profile_id, p.name as profile_name
        FROM benchmark_reports r
        JOIN benchmark_run_participants rp ON rp.id = r.run_participant_id
        JOIN benchmark_profiles p ON p.id = rp.profile_id
        WHERE r.run_id = ?
        ORDER BY r.rank ASC
    `).all(runId);
}

function findReport(runId, runParticipantId){
    return db.prepare("SELECT * FROM benchmark_reports WHERE run_id = ? AND run_participant_id = ?").get(runId, runParticipantId);
}

module.exports = { upsertReport, findReportsByRun, findReport };
