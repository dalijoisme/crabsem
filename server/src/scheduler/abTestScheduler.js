// scheduler/abTestScheduler.js - runs the Regular vs High Throughput
// comparison test every 60s while ab_test_run.status = 'RUNNING'.
// Completely inert (one cheap state read) when the test isn't active.

const abTestEngine = require("../services/abTestEngine");
const { createLockGuard } = require("../services/schedulerLockGuard");

const INTERVAL_MS = 60000;

// SPRINT 12 (Arjuna V5): mandatory lifecycle + watchdog, see
// services/schedulerLockGuard.js's own header.
const lockGuard = createLockGuard("ab-test-scheduler", { maxDurationMs: 10 * INTERVAL_MS });

function tick(){

    if(!lockGuard.tryAcquire()) return;

    try{

        const result = abTestEngine.runCycle();

        if(!result.skipped){

            const summary = result.results.map(r => `${r.profile}: opened=${r.opened} closed=${r.closed} skipped=${r.skipped} equity=$${r.equity.toFixed(2)}`).join(" | ");

            console.log(`[ab-test-scheduler] scanned=${result.scanned} :: ${summary}`);

        }

        lockGuard.release("FINISHED");

    }
    catch(err){

        console.error(`[ab-test-scheduler] FAILED: ${err.message}`, err);
        lockGuard.release("ERROR");

    }

}

function start(){

    console.log(`[ab-test-scheduler] Starting - checking every ${INTERVAL_MS / 1000}s whether the AB test is RUNNING`);

    const timer = setInterval(tick, INTERVAL_MS);

    return { stop(){ clearInterval(timer); } };

}

module.exports = { start, getTickHealth: lockGuard.getHealth };
