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
const pending = new Map(); // id -> { resolve, reject, timer }

// Production Stabilization V1 Final Sprint (Section I - Scheduler
// Safety, "tidak infinite wait"): a real, documented incident (see this
// file's own earlier test/README history) - a batch scoring pass hung
// for 45+ minutes at near-zero CPU (pure I/O wait, not a worker-thread
// crash) with no timeout anywhere to catch it. scoreTokens() is awaited
// directly by scheduler/tradingBotScheduler.js's own live tick (the
// LIVE bot, not just benchmarks) - an unbounded hang here silently
// freezes entry AND exit checks for every user, indefinitely. Grounded
// in the one real, already-established timeout in this exact pipeline -
// collectors/gmgn/authClient.js's own REQUEST_TIMEOUT_MS (15000ms) for
// a single GMGN HTTP call - a batch pass can involve several such calls
// (on-demand wallet-stat cache misses), so this uses the same "generous
// multiple of an established real cadence" convention entryGateService.js's
// freshness gate already uses (4x the trending collector's own tick).
// A timed-out request is rejected on the CALLER's side only - the
// worker itself is never killed (the documented failure mode was pure
// I/O wait, not a wedged event loop, so the worker remains free to
// serve the next real request); a late reply for an already-timed-out
// id is silently ignored by the existing "already resolved/rejected"
// guard below, unchanged.
const WORKER_REQUEST_TIMEOUT_MS = 4 * 15000;

function rejectAllPending(err){
    for(const { reject, timer } of pending.values()){
        clearTimeout(timer);
        reject(err);
    }
    pending.clear();
}

function createWorker(){

    const w = new Worker(path.join(__dirname, "scoringWorker.js"));

    w.on("message", ({ id, signals, error }) => {
        const request = pending.get(id);
        if(!request) return; // already timed out/rejected (e.g. worker restarted) - ignore a late reply
        clearTimeout(request.timer);
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
// timeoutMs: optional override, defaults to the real production value
// above - exists so a test can reliably prove the timeout mechanism
// itself (e.g. 1ms against a real worker, which will always lose the
// race) without either mocking worker_threads or making every test run
// wait out the real 60s production bound.
function scoreTokens(tokens, philosophy, timeoutMs = WORKER_REQUEST_TIMEOUT_MS){
    return new Promise((resolve, reject) => {
        const id = nextRequestId++;
        const timer = setTimeout(() => {
            if(!pending.has(id)) return; // already resolved/rejected right as the timer fired - never double-settle
            pending.delete(id);
            reject(new Error(`scoreTokens timed out after ${timeoutMs}ms - the worker never replied (id=${id}, tokens=${tokens.length})`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        getWorker().postMessage({ id, tokens, philosophy });
    });
}

// Production Stabilization V1 Final Sprint (Section I): the persistent
// worker is otherwise never torn down, which is correct for the real
// server process (it should stay alive for the process lifetime) but
// leaves a dangling thread a test process never naturally exits from.
// No production caller needs this - only test cleanup.
async function shutdown(){
    rejectAllPending(new Error("scoringWorkerPool shut down"));
    if(worker){
        await worker.terminate();
        worker = null;
    }
}

module.exports = { scoreTokens, shutdown, WORKER_REQUEST_TIMEOUT_MS };
