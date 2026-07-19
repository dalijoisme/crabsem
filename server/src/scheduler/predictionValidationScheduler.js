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

let isRunning = false;

function runOnce(){

    if(isRunning){

        console.warn("[prediction-validation-scheduler] Skipped: previous run still in progress");

        return null;

    }

    isRunning = true;

    const startedAt = Date.now();

    try{

        const result = predictionValidationService.runCycle();

        const durationMs = Date.now() - startedAt;

        console.log(

            `[prediction-validation-scheduler] created=${result.createResult.created}/${result.createResult.scanned} scanned, ` +
            `open checked=${result.updateResult.checked} updated=${result.updateResult.updated} closed=${result.updateResult.closed}, ` +
            `timeline recorded=${result.timelineResult.recorded} (${durationMs}ms)`

        );

        // Learn System (Product Improvement Sprint, Part 7) - upserts
        // TODAY's real engine_daily_metrics row on the same cadence as
        // the rest of this cycle. Wrapped in its own try/catch so a
        // failure here can NEVER break the real TP/SL/EXPIRED tracking
        // above - that cycle is load-bearing, this one is additive.

        try{ learnService.recordDailySnapshot(); }

        catch(learnErr){ console.error(`[prediction-validation-scheduler] Learn System snapshot failed: ${learnErr.message}`, learnErr); }

        return result;

    }
    catch(err){

        console.error(`[prediction-validation-scheduler] FAILED: ${err.message}`, err);

        return { ok: false, error: err.message };

    }
    finally{

        isRunning = false;

    }

}

function start(){

    console.log(`[prediction-validation-scheduler] Starting - running every ${config.schedulerIntervalMs / 1000}s`);

    runOnce();

    const timer = setInterval(runOnce, config.schedulerIntervalMs);

    return { stop(){ clearInterval(timer); } };

}

module.exports = { start, runOnce };
