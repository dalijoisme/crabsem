// services/schedulerLockGuard.js - SPRINT 12 (Arjuna V5), mandatory
// scheduler lifecycle: START -> RUNNING -> FINISHED -> LOCK RELEASED,
// or START -> ERROR -> LOCK RELEASED on exception. No scheduler may
// hold a permanent lock.
//
// Every scheduler in this codebase before this sprint duplicated the
// same hand-rolled `let isRunning = false` + try/finally pattern
// (scheduler/gmgnTrendingScheduler.js, predictionValidationScheduler.js,
// missedOpportunityOutcomeScheduler.js, validationScheduler.js,
// walletScheduler.js, walletBalanceSyncScheduler.js, abTestScheduler.js) -
// correct against a thrown exception (try/finally always runs), but with
// NO protection against a genuinely hung, never-resolving `await`
// anywhere inside the guarded work (a future regression reintroducing an
// unbounded call, an underlying library that doesn't honor its own
// timeout, etc.) - that shape permanently wedges `isRunning` true
// forever, which is exactly what "previous batch still in progress"
// logged on every subsequent tick, forever, looks like from outside.
//
// ONE shared implementation instead of seven independent copies -
// tryAcquire()/release() is the same try/finally contract every
// scheduler already had; the watchdog (maxDurationMs) is the new,
// unconditional ceiling: if a lock is still held past that bound, it is
// force-released and logged, regardless of what's still happening
// inside the (presumably wedged) guarded work. release() is idempotent -
// safe to call again if the real work eventually does finish after the
// watchdog already fired, and never double-logs/double-releases.

function createLockGuard(name, { maxDurationMs = null } = {}){

    let isRunning = false;
    let startedAt = null;
    let lastFinishedAt = null;
    let lastDurationMs = null;
    let lastOutcome = null; // "FINISHED" | "ERROR" | "WATCHDOG_RELEASED"
    let watchdogTimer = null;

    function tryAcquire(){

        if(isRunning) return false;

        isRunning = true;
        startedAt = Date.now();
        console.log(`[${name}] START`);

        if(maxDurationMs){
            watchdogTimer = setTimeout(() => {
                console.error(`[${name}] WATCHDOG: lock held longer than ${maxDurationMs}ms - force-releasing so this scheduler can never be permanently stuck`);
                release("WATCHDOG_RELEASED");
            }, maxDurationMs);
            // Never lets a pending watchdog keep the Node process alive
            // on its own - same convention every other timer in this
            // codebase (setInterval-driven schedulers) already relies on
            // process lifetime being governed by the server itself, not
            // by a defensive timer.
            if(typeof watchdogTimer.unref === "function") watchdogTimer.unref();
        }

        return true;

    }

    function release(outcome = "FINISHED"){

        if(!isRunning) return; // already released (watchdog already fired, or a double-release) - never double-log, never throw

        isRunning = false;

        if(watchdogTimer){
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
        }

        const durationMs = startedAt != null ? Date.now() - startedAt : null;
        lastDurationMs = durationMs;
        lastFinishedAt = new Date().toISOString();
        lastOutcome = outcome;
        startedAt = null;

        console.log(`[${name}] ${outcome} - duration=${durationMs}ms - LOCK RELEASED`);

    }

    function getHealth(){

        const stuck = isRunning && startedAt != null && maxDurationMs != null && (Date.now() - startedAt) > maxDurationMs;

        return { isRunning, startedAt, lastFinishedAt, lastDurationMs, lastOutcome, stuck };

    }

    return { tryAcquire, release, getHealth };

}

module.exports = { createLockGuard };
