// scheduler/dailyReviewScheduler.js - Arjuna V4 Phase 2, Daily Trading
// Review infrastructure (original sprint brief Part 3). A genuine
// once-a-day trigger - the Phase 1 audit found no existing job of this
// shape (predictionValidationScheduler.js continuously recomputes
// "today", it never closes out a finished day). Polls every
// CHECK_INTERVAL_MS (generous - this is a low-frequency job, same class
// as walletBalanceSyncScheduler.js's 5-minute cadence, not a realtime
// one) for whether the most recently fully-completed real UTC calendar
// day has been reviewed yet; if not, generates and persists it.
// Idempotent by construction (dailyReviewRepository.upsertReview is a
// real upsert-per-day) - safe to check far more often than it actually
// needs to act.
//
// Same shared watchdog primitive Phase 1 (Engine Stability) already
// proved for 8 of 10 schedulers now - reused here rather than a ninth
// hand-rolled isRunning boolean.

const dailyReviewService = require("../services/dailyReviewService");
const dailyReviewRepository = require("../repositories/dailyReviewRepository");
const { createLockGuard } = require("../services/schedulerLockGuard");

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes - frequent enough that a new day's review appears promptly after rollover, cheap enough (one findByDate query) to check this often

const lockGuard = createLockGuard("daily-review-scheduler", { maxDurationMs: 5 * 60 * 1000 });

let lastGeneratedDate = null;
let lastGeneratedAt = null;
let lastError = null;

// The most recently fully-completed real UTC calendar day - "yesterday"
// relative to the real current UTC date, computed via Date's own UTC
// methods (never a naive string subtraction, which breaks across month/
// year boundaries).
function mostRecentCompletedUtcDate(){
    const now = new Date();
    const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    return yesterday.toISOString().slice(0, 10);
}

function tick(){

    if(!lockGuard.tryAcquire()){
        console.warn("[daily-review-scheduler] Skipped: previous check still in progress");
        return;
    }

    try{

        const dateToReview = mostRecentCompletedUtcDate();

        if(dailyReviewRepository.findByDate(dateToReview)){
            // Already reviewed - the common case on most ticks. Cheap
            // no-op, never re-generates a day that's already done.
            lockGuard.release("FINISHED");
            return;
        }

        const report = dailyReviewService.generateAndPersistReview(dateToReview);

        lastGeneratedDate = dateToReview;
        lastGeneratedAt = new Date().toISOString();
        lastError = null;

        console.log(`[daily-review-scheduler] Generated review for ${dateToReview}: ${report.tradingSummary.totalTrades} trades, winRate=${report.tradingSummary.winRate ?? "n/a"}, netProfitUsd=${report.tradingSummary.netProfitUsd ?? "n/a"}`);

        lockGuard.release("FINISHED");

    }
    catch(err){

        lastError = err.message;
        console.error("[daily-review-scheduler] tick FAILED:", err.message, err);
        lockGuard.release("ERROR");

    }

}

function getTickHealth(){
    const health = lockGuard.getHealth();
    return {
        isRunning: health.isRunning,
        lastFinishedAt: health.lastFinishedAt,
        lastOutcome: health.lastOutcome,
        stuck: health.stuck,
        lastGeneratedDate, lastGeneratedAt, lastError
    };
}

function start(){

    console.log(`[daily-review-scheduler] Starting - checking every ${CHECK_INTERVAL_MS / 60000}min for the most recently completed day's review`);

    tick();

    const timer = setInterval(tick, CHECK_INTERVAL_MS);

    return { stop(){ clearInterval(timer); } };

}

module.exports = { start, tick, getTickHealth, mostRecentCompletedUtcDate };
