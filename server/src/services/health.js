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
// BUY-halt root-cause fix: a real, proven incident (2026-07-31 15:11:51
// -> 2026-08-01) where THIS process's own tradingBotScheduler/
// exitEvaluationScheduler ticks silently stopped running entirely -
// trading_bot_state.status stayed 'RUNNING' the whole time (a static DB
// flag, never revalidated against a live tick), so nothing surfaced the
// halt as anything other than "no error, no explanation". Both
// schedulers' own getTickHealth() (real in-process last-tick timestamps,
// same shape gmgnTrendingScheduler already proved for its own
// collectors) are folded into this endpoint below so a dead tick becomes
// a real, provable /health fact within one tick interval, never
// something that can only be found later by manually diffing timestamps
// across tables.
const tradingBotScheduler = require("../scheduler/tradingBotScheduler");
const exitEvaluationScheduler = require("../scheduler/exitEvaluationScheduler");

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

    // BUY-halt root-cause fix: the two schedulers that actually drive
    // real trading decisions (BUY-side scan/scoring and the independent,
    // faster exit-only cadence) have their own real liveness now, not
    // merely inferred from the GMGN collector's own freshness. In the
    // real incident this closes, every scheduler in the process died
    // together (proven from the database, see tradingBotScheduler.js's
    // own header comment) so the two would normally agree - but they are
    // checked independently here so a FUTURE incident where only one of
    // them wedges (e.g. a single stuck synchronous DB call inside just
    // that scheduler's own code path) is still caught, not silently
    // masked by the other schedulers looking fine.
    const tradingBotTick = tradingBotScheduler.getTickHealth();
    const exitEvaluationTick = exitEvaluationScheduler.getTickHealth();

    // Previously hardcoded to "ok" regardless of scheduler.status, so
    // a monitor/orchestrator gating on this one field could never see
    // a degraded collector - see the production-readiness audit.
    // "stale"/"never_run" both mean real data has stopped flowing in.
    // Now ALSO degraded when a SPECIFIC collector has failed 3+ times in
    // a row (invisible before - only the "trending" collector's own
    // freshness ever showed up here), when a tick is stuck beyond what
    // a normal batch could ever take (see TICK_STUCK_AFTER_MS), or when
    // either the BUY-side or exit-side trading scheduler's own tick has
    // gone stuck/stale.

    const status = (
        scheduler.status === "active"
        && !unhealthyCollectors.length
        && !tick.stuck
        && !tradingBotTick.stuck
        && !exitEvaluationTick.stuck
    ) ? "ok" : "degraded";

    return {

        status,

        database: "connected",

        migrations,

        tokenCount: gmgnTokenRepository.countTokens(),

        scheduler,

        collectors,

        unhealthyCollectors,

        tick,

        tradingBotScheduler: tradingBotTick,

        exitEvaluationScheduler: exitEvaluationTick,

        uptime: process.uptime()

    };

}

module.exports = { checkHealth };
