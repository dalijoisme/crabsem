// scheduler/benchmarkScheduler.js - same shape as
// scheduler/gmgnTrendingScheduler.js / scheduler/tradingBotScheduler.js:
// a setInterval wrapper, never overlapping per run (a still-in-flight
// run's tick is skipped, not queued or run concurrently - same
// convention as the GMGN collector). Ticks EVERY active (RUNNING) run
// each pass, calling services/benchmarkRunService.js for both the
// per-cycle trade evaluation and the duration/auto-complete check -
// this file only owns timing, never trading or lifecycle logic itself.

const benchmarkRunService = require("../services/benchmarkRunService");

const TICK_MS = 15000;

// Same "one flight at a time" pattern gmgnTrendingScheduler.js uses,
// keyed per run_id so multiple simultaneous benchmark runs never block
// each other.
const runningRunIds = new Set();

async function tick(){

    let activeRuns;

    try{
        activeRuns = benchmarkRunService.findActiveRuns();
    }
    catch(err){
        console.error(`[benchmark-scheduler] Failed to load active runs: ${err.message}`, err);
        return;
    }

    for(const run of activeRuns){

        if(runningRunIds.has(run.id)) continue;

        runningRunIds.add(run.id);

        try{
            const result = await benchmarkRunService.processTick(run.id);
            if(result && !result.skipped){
                console.log(`[benchmark-scheduler] run ${run.id} (${run.name}) - scanned=${result.scanned} participants=${result.participantResults?.length ?? 0}${result.completed ? " [COMPLETED]" : ""}`);
            }
        }
        catch(err){
            console.error(`[benchmark-scheduler] run ${run.id} FAILED: ${err.message}`, err);
        }
        finally{
            runningRunIds.delete(run.id);
        }

    }

}

function start(){

    console.log(`[benchmark-scheduler] Starting - checking active benchmark runs every ${TICK_MS / 1000}s`);

    const timer = setInterval(tick, TICK_MS);

    return { stop(){ clearInterval(timer); } };

}

module.exports = { start, tick, TICK_MS };
