// services/scoringWorker.js - Root Cause Analysis fix (event-loop
// starvation, proven via canary-timer + live HTTP-latency reproduction
// in a prior investigation): the synchronous, multi-second, zero-yield
// scoring pass (productionEngineResolver.getActiveEngine().analyzeTokens)
// used to run directly inside a setInterval callback on the main thread,
// blocking every other scheduler (including the live GMGN collector)
// for the full duration of every tick. This file is the worker_threads
// entry point that moves that work off the main thread.
//
// require()-ing productionEngineResolver (and everything it pulls in,
// including database/connection.js) INSIDE this worker gives it its own
// independent module registry, and therefore its own independent
// better-sqlite3 connection to the same file - safe under the existing
// WAL + busy_timeout=5000 (database/connection.js), no new DB
// abstraction needed. This is a plain consequence of how Node's
// worker_threads/module system works, not something built here.
//
// One request in, one response out, per message - never a queue or
// batching scheme of its own (services/scoringWorkerPool.js owns
// sequencing on the main-thread side).

const { parentPort } = require("worker_threads");
const productionEngineResolver = require("./productionEngineResolver");

// Verified across the whole codebase (grep for ".intelligence"): every
// consumer of signal.intelligence (predictionValidationService.js,
// recommendationLoggerService.js) only ever reads
// smartMoney/kol.activities?.length, devWallet.hasData, and
// walletStatsChecked - never a single field of an actual activity row
// (maker address, tx hash, amount, etc). Sending the full raw activity
// arrays back across the worker's message channel for every token is
// pure structured-clone cost for data nothing reads - identified as the
// cause of residual event-loop gaps in the canary-timer verification
// (scoringWorkerPool.verify.js) even after moving the scoring pass
// itself off this thread. Trimming each activities array to its length
// (same .length reads still work, no content to clone) removes that
// cost. researchEngineFactory.js's own return shape is untouched - this
// trims the MESSAGE payload only, not the engine.
//
// Defensive about shape: Production V1 (intelligenceEngine.js) has a
// COMPLETELY different intelligence sub-object (security/holders/etc,
// no smartMoney/kol.activities at all) - only trim fields that actually
// exist, everything else passes through unchanged, since the active
// engine can be switched via config/productionVersionRegistry.js.
function trimForTransfer(signal){
    const sm = signal.intelligence?.smartMoney;
    const kol = signal.intelligence?.kol;
    if(!sm?.activities && !kol?.activities) return signal;
    return {
        ...signal,
        intelligence: {
            ...signal.intelligence,
            ...(sm ? { smartMoney: { ...sm, activities: new Array(sm.activities?.length || 0) } } : {}),
            ...(kol ? { kol: { ...kol, activities: new Array(kol.activities?.length || 0) } } : {})
        }
    };
}

parentPort.on("message", ({ id, tokens, philosophy }) => {

    try{
        const engine = productionEngineResolver.getActiveEngine();
        const signals = engine.analyzeTokens(tokens, philosophy).map(trimForTransfer);
        parentPort.postMessage({ id, signals });
    }
    catch(err){
        parentPort.postMessage({ id, error: err.message });
    }

});
