// scheduler/predictionValidationScheduler.js - the AI Validation
// Framework's own scheduler (Part 2 of the engine-quality sprint 3
// brief: "run every minute"). Deliberately separate from both
// gmgnTrendingScheduler (30s, calls GMGN) and validationScheduler
// (5min, Sprint 2's recommendation_log framework) - this one only
// ever reads data those two already collected (gmgn_tokens,
// token_price_history, gmgn_trenches) plus the Intelligence Engine
// itself; it never calls GMGN directly.

const config = require("../config/predictionValidationConfig");
const predictionValidationService = require("../services/predictionValidationService");
const learnService = require("../services/learnService");
const { createLockGuard } = require("../services/schedulerLockGuard");

// SPRINT 12 (Arjuna V5): watchdog ceiling so this scheduler can never be
// permanently stuck - real root cause of "run berikutnya selalu di-skip"
// was recordTimelineSnapshots() unboundedly re-scanning the entire
// prediction_history table every cycle (see
// repositories/predictionHistoryRepository.js's findRecentLite, this
// sprint's own fix for that), but a watchdog is still mandatory defense-
// in-depth against any future cause of the same symptom.
const lockGuard = createLockGuard("prediction-validation-scheduler", { maxDurationMs: 10 * config.schedulerIntervalMs });

async function runOnce(){

    if(!lockGuard.tryAcquire()){

        console.warn("[prediction-validation-scheduler] Skipped: previous run still in progress");

        return null;

    }

    const startedAt = Date.now();

    try{

        const result = await predictionValidationService.runCycle();

        const durationMs = Date.now() - startedAt;

        console.log(

            `[prediction-validation-scheduler] created=${result.createResult.created}/${result.createResult.scanned} scanned, ` +
            `open checked=${result.updateResult.checked} updated=${result.updateResult.updated} closed=${result.updateResult.closed}, ` +
            `timeline recorded=${result.timelineResult.recorded} (${durationMs}ms, phases=${JSON.stringify(result.phaseDurationsMs)})`

        );

        // Learn System (Product Improvement Sprint, Part 7) - upserts
        // TODAY's real engine_daily_metrics row on the same cadence as
        // the rest of this cycle. Wrapped in its own try/catch so a
        // failure here can NEVER break the real TP/SL/EXPIRED tracking
        // above - that cycle is load-bearing, this one is additive.

        // TEMPORARY (validation-scheduler stall investigation, 2026-08-06) -
        // wall-clock timing around this specific call. Two real
        // event-loop-lag spikes (14134.8ms, 14998.8ms - see
        // services/eventLoopLagDiagnostic.js) directly followed a
        // "FINISHED - duration=Xms" line whose OWN X was ~10.2s larger
        // than the sum of runCycle()'s own three measured phases -
        // this line (learnService.recordDailySnapshot(), called AFTER
        // runCycle() but BEFORE lockGuard.release(), with zero existing
        // timing) is the one real candidate for that gap. Zero behavior
        // change - no return value, control flow, or error handling is
        // touched, only a console.log call is added. Remove once the
        // investigation concludes.
        const _diagLearnStart = process.hrtime.bigint();

        try{ learnService.recordDailySnapshot(); }

        catch(learnErr){ console.error(`[prediction-validation-scheduler] Learn System snapshot failed: ${learnErr.message}`, learnErr); }

        console.log(`[prediction-validation-scheduler-diag] recordDailySnapshot: wallMs=${(Number(process.hrtime.bigint() - _diagLearnStart) / 1e6).toFixed(1)}`);

        lockGuard.release("FINISHED");

        return result;

    }
    catch(err){

        console.error(`[prediction-validation-scheduler] FAILED: ${err.message}`, err);

        lockGuard.release("ERROR");

        return { ok: false, error: err.message };

    }

}

function start(){

    console.log(`[prediction-validation-scheduler] Starting - running every ${config.schedulerIntervalMs / 1000}s`);

    runOnce();

    const timer = setInterval(runOnce, config.schedulerIntervalMs);

    return { stop(){ clearInterval(timer); } };

}

module.exports = { start, runOnce, getTickHealth: lockGuard.getHealth };
