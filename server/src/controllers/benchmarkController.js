// controllers/benchmarkController.js - thin HTTP layer for the
// Benchmark Harness Admin API (Benchmark Harness Architecture Design
// Document section 9). No business logic here - see
// services/benchmarkRunService.js / benchmarkReportService.js.

const benchmarkProfileRepository = require("../repositories/benchmarkProfileRepository");
const benchmarkRunRepository = require("../repositories/benchmarkRunRepository");
const benchmarkPositionRepository = require("../repositories/benchmarkPositionRepository");
const benchmarkStatisticsRepository = require("../repositories/benchmarkStatisticsRepository");
const benchmarkReportRepository = require("../repositories/benchmarkReportRepository");
const benchmarkRunService = require("../services/benchmarkRunService");
const benchmarkReportService = require("../services/benchmarkReportService");
const gmgnTrendingScheduler = require("../scheduler/gmgnTrendingScheduler");
const { sendSuccess, sendError } = require("../utils/apiResponse");

// ---- profiles (the config-only extensibility point) ----

async function listProfiles(req, res, next){
    try{ sendSuccess(res, benchmarkProfileRepository.findAll()); }
    catch(err){ next(err); }
}

async function createProfile(req, res, next){
    try{
        const { name, description, config } = req.body || {};
        if(!name || !config || typeof config !== "object"){
            return sendError(res, 400, "Invalid input", "name and config (object) are required.");
        }
        const created = benchmarkProfileRepository.create({ name, description, configJson: JSON.stringify(config) });
        sendSuccess(res, created);
    }
    catch(err){
        if(String(err.message || "").includes("UNIQUE")) return sendError(res, 409, "Profile already exists", `A benchmark profile named "${req.body?.name}" already exists.`);
        next(err);
    }
}

// ---- runs (lifecycle) ----

async function listRuns(req, res, next){
    try{ sendSuccess(res, benchmarkRunRepository.findAllRuns()); }
    catch(err){ next(err); }
}

async function getRun(req, res, next){
    try{
        const run = benchmarkRunService.getRunStatus(Number(req.params.id));
        if(!run) return sendError(res, 404, "Not found", "No benchmark run with that id.");
        sendSuccess(res, run);
    }
    catch(err){ next(err); }
}

async function startRun(req, res, next){
    try{
        const { name, plannedDurationSeconds, profileNames, marketDataNotes } = req.body || {};
        const result = benchmarkRunService.startRun({ name, plannedDurationSeconds, profileNames, marketDataNotes });
        if(!result.ok) return sendError(res, 400, "Invalid input", result.errors.join(" "));
        sendSuccess(res, result.run);
    }
    catch(err){ next(err); }
}

async function pauseRun(req, res, next){
    try{
        const result = benchmarkRunService.pauseRun(Number(req.params.id));
        if(!result.ok) return sendError(res, 409, "Cannot pause", result.error);
        sendSuccess(res, result.run);
    }
    catch(err){ next(err); }
}

async function resumeRun(req, res, next){
    try{
        const result = benchmarkRunService.resumeRun(Number(req.params.id));
        if(!result.ok) return sendError(res, 409, "Cannot resume", result.error);
        sendSuccess(res, result.run);
    }
    catch(err){ next(err); }
}

async function stopRun(req, res, next){
    try{
        const result = benchmarkRunService.stopRun(Number(req.params.id));
        if(!result.ok) return sendError(res, 409, "Cannot stop", result.error);
        sendSuccess(res, result.run);
    }
    catch(err){ next(err); }
}

// ---- observation (dashboard data sources) ----

async function getRunPositions(req, res, next){
    try{
        const runId = Number(req.params.id);
        const openByParticipant = benchmarkPositionRepository.findAllOpenPositionsForRun(runId);
        const positions = [].concat(...openByParticipant.values());
        sendSuccess(res, positions);
    }
    catch(err){ next(err); }
}

async function getRunStatistics(req, res, next){
    try{
        const participants = benchmarkRunRepository.findParticipantsByRun(Number(req.params.id));
        const curves = participants.map(p => ({
            runParticipantId: p.id,
            profileName: p.profile_name,
            equityCurve: benchmarkStatisticsRepository.findEquityCurve(p.id)
        }));
        sendSuccess(res, curves);
    }
    catch(err){ next(err); }
}

async function getRunReport(req, res, next){
    try{
        const runId = Number(req.params.id);
        const run = benchmarkRunRepository.findRunById(runId);
        if(!run) return sendError(res, 404, "Not found", "No benchmark run with that id.");
        // Always regenerate on request - cheap (pure aggregation over
        // already-collected rows, no re-scoring) and guarantees a
        // RUNNING run's report reflects live standings, not a stale
        // preview from an earlier request.
        const result = benchmarkReportService.generateReport(runId);
        sendSuccess(res, result.reports.map(r => ({ ...r, metrics: JSON.parse(r.metrics_json) })));
    }
    catch(err){ next(err); }
}

// ---- dashboard health (runtime/CPU/memory + delegated collector health) ----

async function getHealth(req, res, next){
    try{
        const memory = process.memoryUsage();
        sendSuccess(res, {
            uptimeSeconds: process.uptime(),
            cpu: process.cpuUsage(),
            memory: { rssMb: memory.rss / 1048576, heapUsedMb: memory.heapUsed / 1048576 },
            activeRuns: benchmarkRunRepository.findActiveRuns().length,
            collectorHealth: gmgnTrendingScheduler.getCollectorHealth(),
            tickHealth: gmgnTrendingScheduler.getTickHealth()
        });
    }
    catch(err){ next(err); }
}

module.exports = {
    listProfiles, createProfile,
    listRuns, getRun, startRun, pauseRun, resumeRun, stopRun,
    getRunPositions, getRunStatistics, getRunReport,
    getHealth
};
