// scheduler/heldPositionRefreshScheduler.js - Held-Position Refresh
// Architecture, Phase 1 (Design 1: Centralized Refresh Loop, approved
// architecture proposal). Root cause this closes (forensic audit): two
// independent schedulers - scheduler/tradingBotScheduler.js's own
// manageOpenPositions() call and scheduler/exitEvaluationScheduler.js's -
// each fetched fresh price/liquidity for EVERY open position, EVERY one
// of their own cycles, with zero coordination between them. Measured
// 64.5% of total GMGN request volume, scaling linearly and unboundedly
// with open-position count.
//
// This scheduler replaces that fan-out with ONE fetch per unique token
// per tick, shared by every RUNNING user's open positions - paper and
// live alike, and by both the BUY-tick and exit-tick's own
// manageOpenPositions() calls, no matter how many of them ask for the
// same token. Writes into services/heldPositionMarketStore.js;
// services/tradingBotEngine.js's refreshStaleHeldToken() reads from that
// store first, falling back to its own original direct fetch whenever
// the store has nothing fresh enough - so a slow tick, a fresh restart,
// or this scheduler being temporarily behind can never mean stale data
// reaches an exit decision, only a slightly less-shared one.
//
// EXPLICITLY OUT OF SCOPE (per the approved proposal): this file changes
// ONLY where price/liquidity numbers come from. It never calls
// dynamicExitService/tradeManager/entryGateService, never opens or
// closes a position, never touches AI scoring - it is a pure data-
// fetching component sitting entirely outside the decision path.
//
// Tick interval matches tradingBotEngine.js's own
// REALTIME_EXIT_REFRESH_TTL_SECONDS (5s) exactly - that constant was
// already the de facto max-refresh-rate ceiling for a held position's
// price before this sprint (the shared on-demand DB cache wouldn't
// return a genuinely newer value more often than every 5s regardless of
// how many callers asked). Reusing it here means this scheduler
// preserves that same real-world freshness floor, never makes it worse,
// and a future change to that one constant keeps both in sync
// automatically.

const tradingBotRepository = require("../repositories/tradingBotRepository");
const gmgnOndemandService = require("../services/gmgnOndemandService");
const heldPositionMarketStore = require("../services/heldPositionMarketStore");
const tradingBotEngine = require("../services/tradingBotEngine");
const { createLockGuard } = require("../services/schedulerLockGuard");
const { withOrigin } = require("../collectors/gmgn/gmgnTrafficAccounting");

const { HELD_POSITION_CHAIN, REALTIME_EXIT_REFRESH_TTL_SECONDS, extractFreshPriceAndLiquidity } = tradingBotEngine;

const INTERVAL_MS = REALTIME_EXIT_REFRESH_TTL_SECONDS * 1000;

// Generous multiple of the tick interval (same "generous versus a real
// batch" convention as every other lock guard in this codebase - see
// scheduler/gmgnTrendingScheduler.js's own maxDurationMs comment) - a
// handful of sequential per-token fetches at ~15s worst-case timeout
// each should never approach this, so it only ever fires on a genuinely
// wedged tick.
const lockGuard = createLockGuard("held-position-refresh-scheduler", { maxDurationMs: 6 * INTERVAL_MS });

let lastTickAt = null;
let lastTickTokenCount = null;
let lastTickErrorCount = null;

// Real union of every RUNNING user's own open-position token addresses -
// paper and live alike (trading_bot_positions carries no paper/live
// distinction of its own; a user's mode lives in trading_bot_config and
// never changes which positions this loop must cover). A token held by
// two different users, or by the same user's BUY-tick and exit-tick both
// wanting to check it, appears exactly once here - that de-duplication
// is the entire point of this scheduler.
function collectOpenPositionTokenAddresses(){

    const runningUserIds = tradingBotRepository.findRunningUserIds();
    const tokenAddresses = new Set();

    for(const userId of runningUserIds){

        const openPositions = tradingBotRepository.findOpenPositions(userId);

        for(const position of openPositions){
            tokenAddresses.add(position.token_address);
        }

    }

    return tokenAddresses;

}

// One token's real fetch + extraction, reusing tradingBotEngine.js's own
// extractFreshPriceAndLiquidity (imported, never re-implemented) so the
// exact same parsing rules govern both this loop's writes and
// refreshStaleHeldToken's own direct-fetch fallback. Fails soft - one
// token's error is logged and skipped, never allowed to abort the rest
// of this tick's tokens (same fail-soft contract refreshStaleHeldToken
// itself already has).
async function refreshOneToken(tokenAddress, ondemandService){

    try{

        const [poolResult, klineResult] = await withOrigin("held-position-refresh-scheduler", () => Promise.all([
            ondemandService.getTokenPoolInfo(HELD_POSITION_CHAIN, tokenAddress, REALTIME_EXIT_REFRESH_TTL_SECONDS),
            ondemandService.getTokenKline(HELD_POSITION_CHAIN, tokenAddress, "1h", REALTIME_EXIT_REFRESH_TTL_SECONDS)
        ]));

        const fresh = extractFreshPriceAndLiquidity(poolResult, klineResult);
        if(!fresh) return false;

        heldPositionMarketStore.set(tokenAddress, { price: fresh.price, liquidity: fresh.liquidity ?? null });
        return true;

    }
    catch(err){

        console.warn(`[held-position-refresh-scheduler] refresh failed for ${tokenAddress}: ${err.message}`);
        return false;

    }

}

// Sequential, not Promise.all-across-tokens - deliberate, matching
// scheduler/gmgnTrendingScheduler.js's own documented reasoning: every
// GMGN call in this process shares one API key's rate limit, so this
// loop bounds its own peak concurrency to the same 2-requests-per-token
// (pool_info + kline) shape refreshStaleHeldToken's direct fetch already
// used, rather than bursting N tokens' worth of requests at once. With
// each unique token fetched at most once per tick (the fix this
// scheduler exists for), the realistic open-position count keeps a full
// pass comfortably inside one INTERVAL_MS tick.
// ondemandService is injectable (default: the real
// services/gmgnOndemandService.js) - same DI seam
// services/tradingBotEngine.js's runCycle()/runExitCycle() already use,
// so this file's own tests never need real GMGN credentials.
async function runOnce(ondemandService = gmgnOndemandService){

    if(!lockGuard.tryAcquire()){
        console.warn(`[held-position-refresh-scheduler] Skipped: previous tick still in progress (${new Date().toISOString()})`);
        return null;
    }

    lastTickAt = Date.now();

    try{

        const tokenAddresses = [...collectOpenPositionTokenAddresses()];
        let errorCount = 0;

        for(const tokenAddress of tokenAddresses){
            const ok = await refreshOneToken(tokenAddress, ondemandService);
            if(!ok) errorCount++;
        }

        lastTickTokenCount = tokenAddresses.length;
        lastTickErrorCount = errorCount;

        lockGuard.release("FINISHED");

        return { ok: true, tokenCount: tokenAddresses.length, errorCount };

    }
    catch(err){

        console.error(`[held-position-refresh-scheduler] tick FAILED: ${err.message}`, err);
        lockGuard.release("ERROR");
        return null;

    }

}

function start(){

    console.log(`[held-position-refresh-scheduler] Starting - refreshing every unique held-position token every ${INTERVAL_MS / 1000}s`);

    runOnce();

    const timer = setInterval(runOnce, INTERVAL_MS);

    return { stop(){ clearInterval(timer); } };

}

// Real, already-tracked state - same shape every other scheduler in this
// codebase exposes for services/health.js, kept here even though it is
// not yet wired into that endpoint (deliberately out of scope for this
// sprint - see the delivery report) so that wiring is a one-line addition
// later, not a new signal to build from scratch.
function getTickHealth(){

    const health = lockGuard.getHealth();

    return {
        isRunning: health.isRunning,
        lastTickAt: lastTickAt != null ? new Date(lastTickAt).toISOString() : null,
        lastTickTokenCount,
        lastTickErrorCount,
        lastFinishedAt: health.lastFinishedAt,
        lastDurationMs: health.lastDurationMs,
        lastOutcome: health.lastOutcome,
        stuck: health.stuck,
        bufferedTokenCount: heldPositionMarketStore.size()
    };

}

module.exports = { start, runOnce, INTERVAL_MS, getTickHealth, collectOpenPositionTokenAddresses };
