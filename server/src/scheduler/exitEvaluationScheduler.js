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

// Arjuna V4 Phase 1 (Engine Stability): the same bound
// scheduler/tradingBotScheduler.js uses for its own outer-tick lock
// guard AND its per-user cycle watchdog (3x its 15s tick) - reused here
// rather than invented fresh, so both critical BUY/SELL loops share one
// traceable "this is definitely wedged" number, comfortably under the
// sprint's <60s auto-recovery ceiling. This scheduler's own outer tick
// is a fixed 1s, so that same 3x-of-outer-tick formula would be far too
// tight for a real exit cycle (RPC/confirmation round-trips) - the
// absolute value is shared instead of the formula.
const USER_CYCLE_WATCHDOG_MS = 45000;

const lastCycleAtByUser = new Map(); // userId -> ms epoch of that user's last exit-evaluation cycle
// userId -> ms epoch when that user's CURRENT exit cycle began (present
// only while a cycle is genuinely in flight). Was a bare Set before
// Arjuna V4 Phase 1 - a wedged runExitCycle() for one user left that
// user's SELL checks permanently stuck with no timeout, and (per the
// audit) the outer tick's own lastTickAt is stamped fresh every 1s
// regardless, so this was invisible to getTickHealth() even if it
// happened for EVERY running user. Now a Map so isDue() can
// watchdog-clear an entry stuck past USER_CYCLE_WATCHDOG_MS, and
// getTickHealth() can report it as a real, visible fact.
const userCycleStartedAt = new Map();

// BUY-halt root-cause fix (see scheduler/tradingBotScheduler.js's own
// header comment on currentTickStartedAt for the real incident this
// closes - a scheduler's own tick() dying silently, with nothing
// anywhere able to prove it, is exactly what let SELL/Dynamic Exit look
// "stuck" with no explanation). Same shape, applied here too since this
// scheduler is the one actually driving real-time exit checks.
let lastTickAt = null;

function getTickHealth(){
    const secondsSinceLastTick = lastTickAt != null ? Math.round((Date.now() - lastTickAt) / 1000) : null;
    // Generous relative to this scheduler's own 1s outer tick - 10x
    // gives real slack for a slow findRunningUserIds() call before
    // calling this scheduler itself stuck, same "generous multiple of an
    // established real cadence" convention used throughout this codebase
    // (see health.js's own STALE_AFTER_SECONDS).
    const stuck = secondsSinceLastTick != null && secondsSinceLastTick > (10 * TICK_MS / 1000);
    const nextTickEtaSeconds = lastTickAt != null
        ? Math.max(0, Math.round((TICK_MS - (Date.now() - lastTickAt)) / 1000))
        : null;
    return {
        lastTickAt: lastTickAt != null ? new Date(lastTickAt).toISOString() : null,
        secondsSinceLastTick,
        // The outer tick's own staleness above proves this scheduler's
        // JS event loop is alive, but (per the audit) says nothing about
        // whether any user's actual exit cycle is progressing - a
        // hung-for-every-user exit cycle looked identical to a healthy
        // tick before Arjuna V4 Phase 1. This is that missing signal.
        stuckUsers: getStuckUserIds(),
        stuck,
        nextTickEtaSeconds
    };
}

function getStuckUserIds(){
    const now = Date.now();
    const stuck = [];
    for(const [userId, startedAt] of userCycleStartedAt){
        if(now - startedAt > USER_CYCLE_WATCHDOG_MS) stuck.push(userId);
    }
    return stuck;
}

function isDue(userId, now){

    const inFlightSince = userCycleStartedAt.get(userId);

    if(inFlightSince != null){

        // Arjuna V4 Phase 1 (Engine Stability): previously an unconditional
        // `return false` forever while this user was "in flight" - a
        // genuinely wedged runExitCycle() permanently blocked just that
        // user's future SELL checks, with no bound and no visible signal.
        if((now - inFlightSince) > USER_CYCLE_WATCHDOG_MS){
            console.error(`[exit-evaluation-scheduler] user=${userId} WATCHDOG: exit cycle in-flight for longer than ${USER_CYCLE_WATCHDOG_MS}ms - force-clearing so this user's exits are never permanently stuck`);
            userCycleStartedAt.delete(userId);
        }
        else{
            return false;
        }

    }

    const config = tradingBotRepository.getConfig(userId);
    const intervalSeconds = config.exit_evaluation_interval_seconds ?? DEFAULT_EXIT_EVALUATION_INTERVAL_SECONDS;
    const lastCycleAt = lastCycleAtByUser.get(userId) || 0;
    return (now - lastCycleAt) >= intervalSeconds * 1000;
}

// Fire-and-forget per user, same convention as tradingBotScheduler.js's
// own runUserCycle() - a slow/stuck user's exit cycle must never block
// another user's, and never blocks this scheduler's own next tick either.
async function runUserExitCycle(userId){

    userCycleStartedAt.set(userId, Date.now());
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

        userCycleStartedAt.delete(userId);

    }

}

function tick(){

    lastTickAt = Date.now();

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
// getTickHealth is exported for services/health.js.
module.exports = { start, tick, DEFAULT_EXIT_EVALUATION_INTERVAL_SECONDS, getTickHealth, TICK_MS };
