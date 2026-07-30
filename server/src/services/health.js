// services/health.js - infrastructure health, not domain data, so
// this is the one service allowed to call database/connection.js
// directly instead of going through a repository for the raw "is
// the DB alive" ping.
//
// "Scheduler status" (getSchedulerStatus) is derived from real data
// (the most recent gmgn_raw_snapshots row) - a reasonable signal on its
// own for the standalone `npm run scheduler:gmgn` deployment mode,
// where this API process genuinely has no in-memory handle to the
// collector. But it only ever reflected ONE collector (the "trending"
// one that writes gmgn_tokens) - a different collector (launchpad_stats,
// gas_price, etc.) could fail every tick forever and this alone would
// never show it (see the collector-staleness investigation).
//
// index.js's real entry point runs the scheduler in THIS SAME PROCESS
// (`npm start`, not the standalone script), so a live, per-collector
// accessor is available and far more precise than inferring anything
// from timestamps - collectorHealth/tickHealth below use it. Requiring
// the scheduler module here has no side effect (it does not call
// .start()) - safe even under the standalone deployment mode, where it
// will just honestly report every collector as never having run in
// THIS process.

const db = require("../database/connection");
const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const gmgnSnapshotRepository = require("../repositories/gmgnSnapshotRepository");
const gmgnTrendingScheduler = require("../scheduler/gmgnTrendingScheduler");

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

    const collectors = gmgnTrendingScheduler.getCollectorHealth();

    const tick = gmgnTrendingScheduler.getTickHealth();

    const unhealthyCollectors = collectors.filter(c => !c.healthy).map(c => c.name);

    // Previously hardcoded to "ok" regardless of scheduler.status, so
    // a monitor/orchestrator gating on this one field could never see
    // a degraded collector - see the production-readiness audit.
    // "stale"/"never_run" both mean real data has stopped flowing in.
    // Now ALSO degraded when a SPECIFIC collector has failed 3+ times in
    // a row (invisible before - only the "trending" collector's own
    // freshness ever showed up here) or when a tick is stuck beyond what
    // a normal batch could ever take (see TICK_STUCK_AFTER_MS).

    const status = (scheduler.status === "active" && !unhealthyCollectors.length && !tick.stuck)
        ? "ok" : "degraded";

    return {

        status,

        database: "connected",

        migrations,

        tokenCount: gmgnTokenRepository.countTokens(),

        scheduler,

        collectors,

        unhealthyCollectors,

        tick,

        uptime: process.uptime()

    };

}

module.exports = { checkHealth };
