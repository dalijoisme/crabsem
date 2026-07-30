// scheduler/gmgnTrendingScheduler.js - runs every registered GMGN
// collector, once each, every 30 seconds. Never overlaps: if a batch
// is still in flight when the next tick fires, that tick is skipped
// rather than queued or run concurrently. Collectors run
// SEQUENTIALLY (not in parallel) with a short delay between them,
// since they all share the same GMGN API key's rate limit.
//
// (File name kept as-is for backward compatibility with
// npm run scheduler:gmgn / scheduler:gmgn-once - this module now
// orchestrates more than just trending.)

const { collectTrending } = require("../collectors/gmgn/trendingCollector");
const { collectTrenches } = require("../collectors/gmgn/trenchesCollector");
const { collectHotSearches } = require("../collectors/gmgn/hotSearchesCollector");
const { collectKolActivity, collectSmartMoneyActivity } = require("../collectors/gmgn/activityFeedCollector");
const { collectGasPrice } = require("../collectors/gmgn/gasPriceCollector");
const { collectLaunchpadStats } = require("../collectors/gmgn/launchpadStatsCollector");

const INTERVAL_MS = 30000;

// Spacing between individual collector calls within one tick - all
// collectors share one GMGN API key's rate limit, so they run one
// after another, not concurrently.
const COLLECTOR_SPACING_MS = 1200;

const COLLECTORS = [

    { name: "trending", run: collectTrending },

    { name: "trenches", run: collectTrenches },

    { name: "hot_searches", run: collectHotSearches },

    { name: "kol_activity", run: collectKolActivity },

    { name: "smart_money_activity", run: collectSmartMoneyActivity },

    { name: "gas_price", run: collectGasPrice },

    { name: "launchpad_stats", run: collectLaunchpadStats }

];

let isRunning = false;

// HEALTH MONITORING (collector-staleness investigation): before this,
// the only externally-visible signal was gmgn_tokens.updated_at - which
// only reflects the "trending" collector. A different collector (say
// launchpad_stats) could fail every single tick forever, get logged to
// a console nobody is watching, and nothing anywhere would ever surface
// it - exactly the "silently stop" failure mode this investigation was
// asked to close. collectorHealth is real, in-process state (this
// scheduler runs inside the same process as the API server - see
// index.js - so a live accessor here is more accurate than inferring
// anything from timestamps in the database).
const collectorHealth = new Map();

// Tick-level stuck detection - if isRunning is somehow still true long
// after a tick should have finished (a future bug reintroducing an
// unbounded await, for example), that's a scheduler that has silently
// stopped making progress, distinct from any single collector failing.
let currentTickStartedAt = null;
let lastTickFinishedAt = null;
let lastTickDurationMs = null;

// Generous relative to a real batch (7 collectors x ~15s worst-case
// timeout + spacing = well under this) - flags a tick that is stuck for
// a reason THIS scheduler itself cannot recover from on its own.
const TICK_STUCK_AFTER_MS = 5 * INTERVAL_MS;

function recordCollectorResult(name, result){

    const state = collectorHealth.get(name) || { consecutiveFailures: 0 };

    if(result.ok){

        state.lastSuccessAt = new Date().toISOString();
        state.consecutiveFailures = 0;
        state.lastError = null;

    }
    else{

        state.lastFailureAt = new Date().toISOString();
        state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
        state.lastError = result.error;

    }

    state.lastDurationMs = result.durationMs;

    collectorHealth.set(name, state);

}

// Real, already-tracked state for every registered collector - never
// re-derived from a guess. `consecutiveFailures >= 3` mirrors the same
// "3x the tick interval" slack already used for STALE_AFTER_SECONDS in
// services/health.js, applied per-collector instead of once globally.
function getCollectorHealth(){

    return COLLECTORS.map(({ name }) => {

        const state = collectorHealth.get(name) || { consecutiveFailures: 0 };

        return {

            name,

            lastSuccessAt: state.lastSuccessAt || null,

            lastFailureAt: state.lastFailureAt || null,

            lastError: state.lastError || null,

            consecutiveFailures: state.consecutiveFailures || 0,

            lastDurationMs: state.lastDurationMs ?? null,

            healthy: (state.consecutiveFailures || 0) < 3

        };

    });

}

function getTickHealth(){

    const stuck = isRunning && currentTickStartedAt != null && (Date.now() - currentTickStartedAt) > TICK_STUCK_AFTER_MS;

    return { isRunning, currentTickStartedAt, lastTickFinishedAt, lastTickDurationMs, stuck };

}

function sleep(ms){

    return new Promise(resolve => setTimeout(resolve, ms));

}

async function runCollector({ name, run }){

    const startedAt = Date.now();

    try{

        const result = await run();

        const durationMs = Date.now() - startedAt;

        console.log(`[gmgn-scheduler] ${name} OK in ${durationMs}ms - ${JSON.stringify(result)}`);

        const outcome = { name, ok: true, durationMs, result };

        recordCollectorResult(name, outcome);

        return outcome;

    }
    catch(err){

        const durationMs = Date.now() - startedAt;

        console.error(`[gmgn-scheduler] ${name} FAILED after ${durationMs}ms: ${err.message}`);

        const outcome = { name, ok: false, durationMs, error: err.message };

        recordCollectorResult(name, outcome);

        return outcome;

    }

}

async function runOnce(){

    if(isRunning){

        console.warn(`[gmgn-scheduler] Skipped: previous batch still in progress (${new Date().toISOString()})`);

        return null;

    }

    isRunning = true;

    const startedAt = Date.now();

    currentTickStartedAt = startedAt;

    const results = [];

    try{

        for(let i=0; i<COLLECTORS.length; i++){

            results.push(await runCollector(COLLECTORS[i]));

            if(i < COLLECTORS.length - 1) await sleep(COLLECTOR_SPACING_MS);

        }

        const durationMs = Date.now() - startedAt;

        const okCount = results.filter(r => r.ok).length;

        console.log(`[gmgn-scheduler] Batch finished in ${durationMs}ms - ${okCount}/${results.length} collectors OK`);

        return { ok: okCount === results.length, durationMs, results };

    }
    finally{

        isRunning = false;

        currentTickStartedAt = null;

        lastTickFinishedAt = new Date().toISOString();

        lastTickDurationMs = Date.now() - startedAt;

    }

}

function start(){

    console.log(`[gmgn-scheduler] Starting - running ${COLLECTORS.length} collectors every ${INTERVAL_MS / 1000}s`);

    runOnce();

    const timer = setInterval(runOnce, INTERVAL_MS);

    return {

        stop(){

            clearInterval(timer);

        }

    };

}

module.exports = { start, runOnce, INTERVAL_MS, COLLECTORS, getCollectorHealth, getTickHealth };
