// scheduler/abTestScheduler.js - runs the Regular vs High Throughput
// comparison test every 60s while ab_test_run.status = 'RUNNING'.
// Completely inert (one cheap state read) when the test isn't active.

const abTestEngine = require("../services/abTestEngine");

const INTERVAL_MS = 60000;

let isRunning = false;

function tick(){

    if(isRunning) return;

    isRunning = true;

    try{

        const result = abTestEngine.runCycle();

        if(!result.skipped){

            const summary = result.results.map(r => `${r.profile}: opened=${r.opened} closed=${r.closed} skipped=${r.skipped} equity=$${r.equity.toFixed(2)}`).join(" | ");

            console.log(`[ab-test-scheduler] scanned=${result.scanned} :: ${summary}`);

        }

    }
    catch(err){

        console.error(`[ab-test-scheduler] FAILED: ${err.message}`, err);

    }
    finally{

        isRunning = false;

    }

}

function start(){

    console.log(`[ab-test-scheduler] Starting - checking every ${INTERVAL_MS / 1000}s whether the AB test is RUNNING`);

    const timer = setInterval(tick, INTERVAL_MS);

    return { stop(){ clearInterval(timer); } };

}

module.exports = { start };
