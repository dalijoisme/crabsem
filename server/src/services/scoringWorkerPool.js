// services/scoringWorkerPool.js - Root Cause Analysis fix (event-loop
// starvation). Thin async wrapper around ONE persistent worker_thread
// running services/scoringWorker.js - the diagnosis's own "smallest
// fix", not a multi-worker pool (scale only if profiling ever shows
// queuing delay - see the Sprint A plan's explicit non-goal).
//
// Both call sites that used to run the expensive batch scoring pass
// directly on the main thread (services/predictionValidationService.js's
// evaluateAndRecordDecisions and services/benchmarkRunner.js's
// computeProfileSignals) now go through scoreTokens() here instead of
// calling productionEngineResolver.getActiveEngine().analyzeTokens()
// themselves.

const path = require("path");
const { Worker } = require("worker_threads");

let worker = null;
let nextRequestId = 1;
const pending = new Map(); // id -> { resolve, reject }

function rejectAllPending(err){
    for(const { reject } of pending.values()) reject(err);
    pending.clear();
}

function createWorker(){

    const w = new Worker(path.join(__dirname, "scoringWorker.js"));

    w.on("message", ({ id, signals, error }) => {
        const request = pending.get(id);
        if(!request) return; // already rejected (e.g. worker restarted) - ignore a late reply
        pending.delete(id);
        if(error) request.reject(new Error(error));
        else request.resolve(signals);
    });

    // A crashed/exited worker must never mean "scoring silently stops
    // forever" - reject whatever was in flight and let the NEXT call to
    // scoreTokens() lazily create a fresh worker (getWorker() below).
    w.on("error", (err) => {
        rejectAllPending(err);
        worker = null;
    });

    w.on("exit", (code) => {
        if(code !== 0) rejectAllPending(new Error(`scoringWorker exited unexpectedly with code ${code}`));
        worker = null;
    });

    return w;

}

function getWorker(){
    if(!worker) worker = createWorker();
    return worker;
}

// tokens/philosophy must be plain, structured-clonable data (they
// already are - token rows are plain better-sqlite3 result objects,
// philosophy is the same plain JSON-safe shape strategyProfileTranslator
// already produces). Returns the same signals array
// productionEngineResolver.getActiveEngine().analyzeTokens(tokens, philosophy)
// would have returned synchronously before this fix - only the calling
// convention (awaited, not blocking) changes.
function scoreTokens(tokens, philosophy){
    return new Promise((resolve, reject) => {
        const id = nextRequestId++;
        pending.set(id, { resolve, reject });
        getWorker().postMessage({ id, tokens, philosophy });
    });
}

module.exports = { scoreTokens };
