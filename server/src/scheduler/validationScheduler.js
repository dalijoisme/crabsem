// scheduler/validationScheduler.js - runs the recommendation logger
// and outcome evaluator (Sprint 2 validation framework) on their own,
// coarser interval - separate from gmgnTrendingScheduler's 30s GMGN
// collection loop, since neither of these steps calls GMGN at all
// (they only read/write local SQLite), and logging every 30s would
// bloat recommendation_log ~17x faster than useful for backtesting.

const validationConfig = require("../config/validationConfig");
const { logRecommendations } = require("../services/recommendationLoggerService");
const { evaluateDueOutcomes } = require("../services/outcomeEvaluatorService");
const { pruneOldData } = require("../services/retentionService");

let isRunning = false;

async function runOnce(){

    if(isRunning){

        console.warn("[validation-scheduler] Skipped: previous run still in progress");

        return null;

    }

    isRunning = true;

    const startedAt = Date.now();

    try{

        const logResult = logRecommendations();

        const evalResult = evaluateDueOutcomes();

        const pruneResult = pruneOldData();

        const durationMs = Date.now() - startedAt;

        console.log(`[validation-scheduler] Logged ${logResult.logged} recommendations, evaluated outcomes: ${JSON.stringify(evalResult)}, pruned: ${JSON.stringify(pruneResult)} (${durationMs}ms)`);

        return { logResult, evalResult, pruneResult, durationMs };

    }
    catch(err){

        console.error(`[validation-scheduler] FAILED: ${err.message}`);

        return { ok: false, error: err.message };

    }
    finally{

        isRunning = false;

    }

}

function start(){

    console.log(`[validation-scheduler] Starting - logging + evaluating every ${validationConfig.intervalMs / 1000}s`);

    runOnce();

    const timer = setInterval(runOnce, validationConfig.intervalMs);

    return {

        stop(){

            clearInterval(timer);

        }

    };

}

module.exports = { start, runOnce };
