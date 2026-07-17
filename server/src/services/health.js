// services/health.js - infrastructure health, not domain data, so
// this is the one service allowed to call database/connection.js
// directly instead of going through a repository for the raw "is
// the DB alive" ping.
//
// "Scheduler status" is derived from real data (the most recent
// gmgn_raw_snapshots row), not an in-process flag: the scheduler
// (npm run scheduler:gmgn) runs as its own long-running process,
// separate from the API server (npm start) - the API process has no
// in-memory handle to it, so the only honest signal available here
// is "how long ago did a collector run actually finish."

const db = require("../database/connection");
const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const gmgnSnapshotRepository = require("../repositories/gmgnSnapshotRepository");

const COLLECTOR_ENDPOINT = "market_rank";

// The scheduler runs every 30s (see scheduler/gmgnTrendingScheduler.js);
// 3x that gives slack for one slow run before calling it "stale".
const STALE_AFTER_SECONDS = 90;

function getSchedulerStatus(){

    const latest = gmgnSnapshotRepository.getLatestSnapshotMeta(COLLECTOR_ENDPOINT);

    if(!latest){

        return { lastRunAt: null, secondsSinceLastRun: null, status: "never_run" };

    }

    // SQLite's CURRENT_TIMESTAMP is UTC as "YYYY-MM-DD HH:MM:SS" (no
    // timezone marker) - convert to ISO-8601 explicitly so Date
    // parsing is unambiguous rather than relying on engine-specific
    // non-ISO parsing behavior.

    const isoTimestamp = `${latest.fetched_at.replace(" ", "T")}Z`;

    const secondsSinceLastRun = Math.round((Date.now() - Date.parse(isoTimestamp)) / 1000);

    return {

        lastRunAt: latest.fetched_at,

        secondsSinceLastRun,

        status: secondsSinceLastRun <= STALE_AFTER_SECONDS ? "active" : "stale"

    };

}

function checkHealth(){

    db.prepare("SELECT 1").get();

    const { count: migrations } = db.prepare(
        "SELECT COUNT(*) as count FROM schema_migrations"
    ).get();

    const scheduler = getSchedulerStatus();

    // Previously hardcoded to "ok" regardless of scheduler.status, so
    // a monitor/orchestrator gating on this one field could never see
    // a degraded collector - see the production-readiness audit.
    // "stale"/"never_run" both mean real data has stopped flowing in,
    // which is exactly what a health check exists to surface.

    const status = scheduler.status === "active" ? "ok" : "degraded";

    return {

        status,

        database: "connected",

        migrations,

        tokenCount: gmgnTokenRepository.countTokens(),

        scheduler,

        uptime: process.uptime()

    };

}

module.exports = { checkHealth };
