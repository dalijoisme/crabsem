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

function sleep(ms){

    return new Promise(resolve => setTimeout(resolve, ms));

}

async function runCollector({ name, run }){

    const startedAt = Date.now();

    try{

        const result = await run();

        const durationMs = Date.now() - startedAt;

        console.log(`[gmgn-scheduler] ${name} OK in ${durationMs}ms - ${JSON.stringify(result)}`);

        return { name, ok: true, durationMs, result };

    }
    catch(err){

        const durationMs = Date.now() - startedAt;

        console.error(`[gmgn-scheduler] ${name} FAILED after ${durationMs}ms: ${err.message}`);

        return { name, ok: false, durationMs, error: err.message };

    }

}

async function runOnce(){

    if(isRunning){

        console.warn(`[gmgn-scheduler] Skipped: previous batch still in progress (${new Date().toISOString()})`);

        return null;

    }

    isRunning = true;

    const startedAt = Date.now();

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

module.exports = { start, runOnce, INTERVAL_MS, COLLECTORS };
