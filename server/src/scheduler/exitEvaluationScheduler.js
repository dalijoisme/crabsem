// scheduler/exitEvaluationScheduler.js - Exit Evaluation Interval sprint.
// Independent of scheduler/tradingBotScheduler.js's own scan_interval_seconds
// cadence (the BUY-side scan/AI-scoring pass) - this scheduler ONLY ever
// evaluates each running user's own currently-OPEN positions, on that
// user's own trading_bot_config.exit_evaluation_interval_seconds (default
// 5s, 1-30s range enforced by services/tradingBotService.js's
// updateTradingConfiguration()). It never calls
// gmgnTokenRepository.getAllTokens(), services/scoringWorkerPool.js, or
// services/tradingBotEngine.js's orderCandidates()/entryGateService path -
// so running this more often can never increase BUY-side scan/RPC cost.
//
// Same per-user due-tracking/fire-and-forget shape as tradingBotScheduler.js
// (lastCycleAtByUser/userCycleInFlight Maps) - just a much finer outer tick
// (1s, fine enough to honor a 1s-configured user promptly) driving
// services/tradingBotEngine.js's runExitCycle() instead of runCycle().

const tradingBotRepository = require("../repositories/tradingBotRepository");
const tradingBotEngine = require("../services/tradingBotEngine");

const TICK_MS = 1000;

// Real, non-migrated-yet fallback only - migration 062 gives every real
// row a column default of 5, so this should never actually be reached
// against a real trading_bot_config row.
const DEFAULT_EXIT_EVALUATION_INTERVAL_SECONDS = 5;

const lastCycleAtByUser = new Map(); // userId -> ms epoch of that user's last exit-evaluation cycle
const userCycleInFlight = new Set(); // userId currently mid-cycle - so one user's slow cycle can't overlap ITSELF; never blocks another user's

function isDue(userId, now){
    if(userCycleInFlight.has(userId)) return false;
    const config = tradingBotRepository.getConfig(userId);
    const intervalSeconds = config.exit_evaluation_interval_seconds ?? DEFAULT_EXIT_EVALUATION_INTERVAL_SECONDS;
    const lastCycleAt = lastCycleAtByUser.get(userId) || 0;
    return (now - lastCycleAt) >= intervalSeconds * 1000;
}

// Fire-and-forget per user, same convention as tradingBotScheduler.js's
// own runUserCycle() - a slow/stuck user's exit cycle must never block
// another user's, and never blocks this scheduler's own next tick either.
async function runUserExitCycle(userId){

    userCycleInFlight.add(userId);
    lastCycleAtByUser.set(userId, Date.now());

    try{

        const result = await tradingBotEngine.runExitCycle(userId);

        if(result.reason !== "NOT_RUNNING" && result.reason !== "LIVE_MODE_NOT_AUTHORIZED"){
            console.log(`[exit-evaluation-scheduler] user=${userId} closed=${result.closed}`);
        }

    }
    catch(err){

        console.error(`[exit-evaluation-scheduler] user=${userId} FAILED: ${err.message}`, err);

    }
    finally{

        userCycleInFlight.delete(userId);

    }

}

function tick(){

    const runningUserIds = tradingBotRepository.findRunningUserIds();
    if(!runningUserIds.length) return;

    const now = Date.now();

    for(const userId of runningUserIds){
        if(isDue(userId, now)) runUserExitCycle(userId);
    }

}

function start(){

    console.log(`[exit-evaluation-scheduler] Starting - checking every ${TICK_MS / 1000}s for any RUNNING user due for their own exit evaluation interval`);

    const timer = setInterval(() => {
        try{ tick(); }
        catch(err){ console.error("[exit-evaluation-scheduler] tick FAILED", err); }
    }, TICK_MS);

    return { stop(){ clearInterval(timer); } };

}

// tick is exported alongside start purely for this file's own regression
// test, same convention scheduler/tradingBotScheduler.js already uses.
module.exports = { start, tick, DEFAULT_EXIT_EVALUATION_INTERVAL_SECONDS };
