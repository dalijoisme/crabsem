// scheduler/gmgnTrendingScheduler.js - runs every registered GMGN
// collector, once each, every 30 seconds. Never overlaps: if a batch
// is still in flight when the next tick fires, that tick is skipped
// rather than queued or run concurrently. Collectors run
// SEQUENTIALLY (not in parallel) with a short delay between them,
// since they all share the same GMGN API key's rate limit.
//
// (File name kept as-is for backward compatibility with
// npm run scheduler:gmgn / scheduler:gmgn-once - this module now
// orchestrates more than just trending.)

const { collectTrending } = require("../collectors/gmgn/trendingCollector");
const { collectTrenches } = require("../collectors/gmgn/trenchesCollector");
const { collectHotSearches } = require("../collectors/gmgn/hotSearchesCollector");
const { collectKolActivity, collectSmartMoneyActivity } = require("../collectors/gmgn/activityFeedCollector");
const { collectGasPrice } = require("../collectors/gmgn/gasPriceCollector");
const { collectLaunchpadStats } = require("../collectors/gmgn/launchpadStatsCollector");
const { createLockGuard } = require("../services/schedulerLockGuard");
// TEMPORARY (P0 GMGN IP ban investigation) - see
// collectors/gmgn/requestDiagnostics.js header. Remove this import +
// the startTick()/endTick() calls below once closed.
const requestDiagnostics = require("../collectors/gmgn/requestDiagnostics");
// Arjuna V4 Phase 2 (Realtime Pulse) - chained onto THIS scheduler's own
// tick rather than an independently-scheduled timer, specifically to
// avoid the "duplicate polling" class of bug two independently-drifting
// timers could cause (PHASE2_ARCHITECTURE_REVIEW.md Section 8). Consumes
// only data this tick's own collectors already fetched - zero new GMGN
// calls.
const freshUniverseService = require("../services/freshUniverseService");
const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const gmgnActivityFeedRepository = require("../repositories/gmgnActivityFeedRepository");
const realtimePulseService = require("../services/realtimePulseService");
const realtimePulseBufferService = require("../services/realtimePulseBufferService");

const INTERVAL_MS = 30000;

// Spacing between individual collector calls within one tick - all
// collectors share one GMGN API key's rate limit, so they run one
// after another, not concurrently.
const COLLECTOR_SPACING_MS = 1200;

const COLLECTORS = [

    { name: "trending", run: collectTrending },

    { name: "trenches", run: collectTrenches },

    { name: "hot_searches", run: collectHotSearches },

    { name: "kol_activity", run: collectKolActivity },

    { name: "smart_money_activity", run: collectSmartMoneyActivity },

    { name: "gas_price", run: collectGasPrice },

    { name: "launchpad_stats", run: collectLaunchpadStats }

];

// SPRINT 12 (Arjuna V5): the hand-rolled isRunning boolean below is
// replaced by the shared lock guard (services/schedulerLockGuard.js) -
// same try/finally contract as before, PLUS a watchdog ceiling so this
// scheduler can never be permanently stuck ("previous batch still in
// progress" forever) even if something inside runOnce() truly hangs
// (a never-resolving await) despite every collector already having its
// own 15s HTTP timeout (collectors/gmgn/authClient.js).
//
// maxDurationMs recalibrated (2026-08-06, live VPS, RATE_LIMIT_BANNED
// incident follow-up): the original 5 * 30000 = 150000ms assumed a
// CLEAN 15s worst case per collector (7 x 15s + spacing = ~112s), but
// real production evidence (requestDiagnostics.js's own logged
// startedAtMs/finishedAtMs for every GMGN request) proved individual
// collector calls that genuinely stall take 17,000-28,355ms to actually
// resolve, not a clean 15,000ms - AbortSignal.timeout(15000) has real
// observed overhead beyond its nominal value. Confirmed NOT caused by
// connection-pool reuse (an isolated reproduction script, same
// unmodified authClient.js, proved keep-alive reuse and idle-eviction
// both work correctly), NOT overlapping/duplicate requests (direct
// timestamp-overlap analysis of the real request log found none), and
// NOT aggregate request-volume throttling (single isolated requests in
// otherwise-quiet minutes still occasionally stalled) - this is
// intermittent, low-frequency, real external latency on individual
// requests. With the corrected per-request worst case, 7 sequential
// collectors can legitimately need up to ~7 x 28s + 6 x 1.2s spacing =
// ~203s even when NOTHING is stuck - already past the old 150s ceiling,
// which caused the watchdog to force-release ticks that were still
// genuinely (if slowly) making progress, discarding their own
// in-flight work and forcing gmgn_tokens to wait for the NEXT tick
// instead. 10x the tick interval matches the same convention already
// used by scheduler/heldPositionRefreshScheduler.js (6x) and
// scheduler/predictionValidationScheduler.js / validationScheduler.js
// (10x) - this scheduler's old 5x was the outlier, not a deliberately
// tighter bound.
const lockGuard = createLockGuard("gmgn-scheduler", { maxDurationMs: 10 * INTERVAL_MS });

// HEALTH MONITORING (collector-staleness investigation): before this,
// the only externally-visible signal was gmgn_tokens.updated_at - which
// only reflects the "trending" collector. A different collector (say
// launchpad_stats) could fail every single tick forever, get logged to
// a console nobody is watching, and nothing anywhere would ever surface
// it - exactly the "silently stop" failure mode this investigation was
// asked to close. collectorHealth is real, in-process state (this
// scheduler runs inside the same process as the API server - see
// index.js - so a live accessor here is more accurate than inferring
// anything from timestamps in the database).
const collectorHealth = new Map();

// RATE_LIMIT_BANNED incident (2026-08-06), same real-production finding
// as heldPositionRefreshScheduler.js's own cooldownUntilMs (see that
// file's header for the full live-log evidence): this scheduler ticks
// every 30s with NO backoff of its own either - runCollector() below
// only ever console.error's a 429, never slows anything down, so the
// NEXT tick retried all 7 collectors again regardless. Live evidence
// from the SAME incident window: after heldPositionRefreshScheduler.js's
// own circuit breaker was deployed and stopped ITS retries, this
// scheduler alone kept producing "0/7 collectors OK" batches every 30s
// straight through an active ban - confirming this scheduler's own
// retries were independently sufficient to keep the ban from ever
// expiring. Global (one cooldown for the whole batch, not per-collector)
// for the same reason as the held-position scheduler's: the ban is
// IP-wide, so a DIFFERENT collector succeeding at full speed while
// another just got banned would still hammer the same banned IP.
//
// Confirmed by direct user report (2026-08-06): GMGN's own temporary
// ban is ~5 minutes. 60s (this file's original guess) was proven too
// short by real observation - it made this scheduler probe every
// minute straight through a still-active ban. 6 minutes gives real
// safety margin over the confirmed 5. A THIRD independent no-backoff
// source (services/tradingBotEngine.js's refreshStaleHeldToken fallback)
// was found and fixed in the same pass - see that file's own comment.
//
// EARLY_PROBE_DELAY_MS: same mitigation as heldPositionRefreshScheduler.js's
// own (see that file's header) - a full 6-minute blackout on gmgn_tokens
// freshness stalls the whole BUY-candidate universe, not just this
// scheduler's own health. ONE real collector call partway through the
// cooldown checks whether the ban already cleared; success ends the
// blackout immediately, failure re-arms a fresh cooldown + checkpoint.
const RATE_LIMIT_COOLDOWN_MS = 6 * 60 * 1000;
const EARLY_PROBE_DELAY_MS = 90 * 1000;
let cooldownUntilMs = 0;
let earlyProbeAtMs = 0;
let earlyProbeAttempted = false;

function recordCollectorResult(name, result){

    const state = collectorHealth.get(name) || { consecutiveFailures: 0 };

    if(result.ok){

        state.lastSuccessAt = new Date().toISOString();
        state.consecutiveFailures = 0;
        state.lastError = null;

    }
    else{

        state.lastFailureAt = new Date().toISOString();
        state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
        state.lastError = result.error;

    }

    state.lastDurationMs = result.durationMs;

    collectorHealth.set(name, state);

}

// Real, already-tracked state for every registered collector - never
// re-derived from a guess. `consecutiveFailures >= 3` mirrors the same
// "3x the tick interval" slack already used for STALE_AFTER_SECONDS in
// services/health.js, applied per-collector instead of once globally.
function getCollectorHealth(){

    return COLLECTORS.map(({ name }) => {

        const state = collectorHealth.get(name) || { consecutiveFailures: 0 };

        return {

            name,

            lastSuccessAt: state.lastSuccessAt || null,

            lastFailureAt: state.lastFailureAt || null,

            lastError: state.lastError || null,

            consecutiveFailures: state.consecutiveFailures || 0,

            lastDurationMs: state.lastDurationMs ?? null,

            healthy: (state.consecutiveFailures || 0) < 3

        };

    });

}

// Same external shape as before this sprint (services/health.js's own
// contract - checkHealth() reads tick.stuck; the full object is embedded
// verbatim in the /health response) - field names preserved
// (currentTickStartedAt/lastTickFinishedAt/lastTickDurationMs), now
// sourced from the shared lock guard instead of duplicated bookkeeping.
// lastOutcome is new/additive.
function getTickHealth(){

    const health = lockGuard.getHealth();

    return {
        isRunning: health.isRunning,
        currentTickStartedAt: health.startedAt,
        lastTickFinishedAt: health.lastFinishedAt,
        lastTickDurationMs: health.lastDurationMs,
        lastOutcome: health.lastOutcome,
        stuck: health.stuck
    };

}

function sleep(ms){

    return new Promise(resolve => setTimeout(resolve, ms));

}

// isProbeAttempt: true only for the SINGLE, deliberately-designated
// probe call each cooldown cycle (see runOnce's own comment) - never
// inferred from cooldownUntilMs alone. In a NORMAL (non-cooldown)
// tick, every collector runs regardless of an earlier one's failure -
// if collector 1 trips a fresh cooldown and collector 2 (run right
// after, same tick) happens to succeed anyway, that unrelated success
// must never be mistaken for the probe and clear the cooldown collector
// 1 JUST set.
async function runCollector({ name, run }, isProbeAttempt = false){

    const startedAt = Date.now();

    try{

        const result = await run();

        const durationMs = Date.now() - startedAt;

        console.log(`[gmgn-scheduler] ${name} OK in ${durationMs}ms - ${JSON.stringify(result)}`);

        // Only the designated probe attempt may clear the cooldown on
        // success.
        if(isProbeAttempt){
            console.warn(`[gmgn-scheduler] Early-exit probe succeeded on ${name} - GMGN ban has cleared, resuming normal collector batches immediately`);
            cooldownUntilMs = 0;
            earlyProbeAttempted = false;
        }

        const outcome = { name, ok: true, durationMs, result };

        recordCollectorResult(name, outcome);

        return outcome;

    }
    catch(err){

        const durationMs = Date.now() - startedAt;

        console.error(`[gmgn-scheduler] ${name} FAILED after ${durationMs}ms: ${err.message}`);

        // err.status is set from the real HTTP response (see
        // authClient.js's GmgnAuthError) - a bare timeout carries no
        // status, so this only trips on a REAL 429 from GMGN, never on
        // an ordinary network hiccup. See cooldownUntilMs's own header
        // comment for the real-incident evidence behind this.
        if(err.status === 429){
            cooldownUntilMs = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            earlyProbeAtMs = Date.now() + EARLY_PROBE_DELAY_MS;
            earlyProbeAttempted = false;
            console.warn(`[gmgn-scheduler] GMGN returned 429 (${err.apiError || "rate limited"}) on ${name} - pausing the WHOLE collector batch for ${RATE_LIMIT_COOLDOWN_MS / 1000}s (IP-wide ban, early-exit probe at ${EARLY_PROBE_DELAY_MS / 1000}s) to stop re-triggering it`);
        }

        const outcome = { name, ok: false, durationMs, error: err.message };

        recordCollectorResult(name, outcome);

        return outcome;

    }

}

// Arjuna V4 Phase 2 (Realtime Pulse) - own liveness/cost tracking,
// separate from the collector batch's own getTickHealth() above, so a
// slow/failed Pulse tick is a real, independently-visible fact (same
// "every important signal must be observable" requirement the rest of
// this sprint follows) without conflating it with collector health.
let lastPulseTickAt = null;
let lastPulseDurationMs = null;
let lastPulseTokenCount = null;
let lastPulseEvictedCount = null;
let lastPulseError = null;

function getPulseHealth(){
    return {
        lastPulseTickAt, lastPulseDurationMs, lastPulseTokenCount, lastPulseEvictedCount, lastPulseError,
        bufferedTokenCount: realtimePulseBufferService.size()
    };
}

// Deferred via setImmediate - runs AFTER this collector tick's own lock
// has already been released and its own duration/health already
// recorded, so Pulse's cost can never count against or delay the
// collector batch's own health signal, and yields to any pending I/O
// callback first (PHASE2_ARCHITECTURE_REVIEW.md Section 3/8's "scheduler
// starvation" mitigation). Scoped strictly to the fresh-universe
// population already computed for scoring - never the full gmgn_tokens
// table. Measured cost (durationMs, logged every tick) is expected to
// stay in the low milliseconds for a fresh-universe population of a few
// hundred tokens (see PHASE2_ARCHITECTURE_REVIEW.md Section 7's
// estimate); if production data ever shows this growing large, the
// documented next step is offloading to a worker thread the same way
// services/scoringWorkerPool.js already does for scoring - not
// implemented here since there is no evidence yet that it's needed
// ("don't design for hypothetical future requirements").
function triggerRealtimePulseTick(){

    setImmediate(() => {

        const tickStartedAt = Date.now();

        try{

            const { tokens } = freshUniverseService.getBuyCandidateUniverse();
            const tokenAddresses = tokens.map(t => t.token_address);

            const trenchesByAddress = gmgnTrenchesRepository.findManyByTokenAddresses(tokenAddresses);
            const smartMoneyRows = gmgnActivityFeedRepository.findAllByType("smart_money");
            const kolRows = gmgnActivityFeedRepository.findAllByType("kol");

            const result = realtimePulseService.runPulseTick({
                tokens, trenchesByAddress, smartMoneyRows, kolRows, nominalIntervalMs: INTERVAL_MS
            });

            lastPulseTickAt = new Date().toISOString();
            lastPulseDurationMs = result.durationMs;
            lastPulseTokenCount = result.tokenCount;
            lastPulseEvictedCount = result.evictedCount;
            lastPulseError = null;

            console.log(`[realtime-pulse] tick complete: tokens=${result.tokenCount} evicted=${result.evictedCount} duration=${result.durationMs}ms (own overhead: ${Date.now() - tickStartedAt}ms)`);

        }
        catch(err){

            lastPulseError = err.message;
            console.error("[realtime-pulse] tick FAILED (collector data itself unaffected):", err.message, err);

        }

    });

}

async function runOnce(){

    if(!lockGuard.tryAcquire()){

        console.warn(`[gmgn-scheduler] Skipped: previous batch still in progress (${new Date().toISOString()})`);

        return null;

    }

    // Circuit breaker (see cooldownUntilMs's own header comment) - skip
    // every collector this tick without making a single GMGN call,
    // rather than retrying into a ban that has not had time to expire
    // yet - EXCEPT the single early-exit probe (EARLY_PROBE_DELAY_MS)
    // partway through, allowed exactly once per cooldown cycle. Lock is
    // released immediately so the very next tick after the cooldown
    // clears gets a real attempt, never delayed further.
    const inCooldown = Date.now() < cooldownUntilMs;
    const isEarlyProbe = inCooldown && !earlyProbeAttempted && Date.now() >= earlyProbeAtMs;

    if(inCooldown && !isEarlyProbe){
        console.warn(`[gmgn-scheduler] Skipped: in GMGN 429 cooldown for ${Math.ceil((cooldownUntilMs - Date.now()) / 1000)}s more`);
        lockGuard.release("FINISHED");
        return { ok: false, durationMs: 0, results: [], cooldown: true };
    }

    const startedAt = Date.now();
    const results = [];
    // TEMPORARY (P0 GMGN IP ban investigation) - marks the tick
    // boundary so requestDiagnostics can group/order every request
    // this tick issues. No effect on control flow.
    requestDiagnostics.startTick();

    try{

        if(isEarlyProbe){
            earlyProbeAttempted = true;
            console.warn("[gmgn-scheduler] Early-exit probe: attempting ONE real collector call mid-cooldown to check if the ban already cleared");
        }

        for(let i=0; i<COLLECTORS.length; i++){

            // Only the FIRST collector this tick is ever the designated
            // probe - once it succeeds, cooldownUntilMs is already 0,
            // so every later collector this tick is just an ordinary call.
            const isProbeAttempt = isEarlyProbe && i === 0;

            results.push(await runCollector(COLLECTORS[i], isProbeAttempt));

            // The probe itself just failed (still banned) - runCollector's
            // own catch already re-armed a fresh cooldown; stop here,
            // never attempt the remaining collectors this tick.
            if(isProbeAttempt && !results[results.length - 1].ok) break;

            if(i < COLLECTORS.length - 1) await sleep(COLLECTOR_SPACING_MS);

        }

        const durationMs = Date.now() - startedAt;

        const okCount = results.filter(r => r.ok).length;

        console.log(`[gmgn-scheduler] Batch finished in ${durationMs}ms - ${okCount}/${results.length} collectors OK`);

        requestDiagnostics.endTick();

        lockGuard.release("FINISHED");

        // Deliberately AFTER release() (this batch's own duration/health
        // is already finalized above) and deliberately NOT awaited - see
        // triggerRealtimePulseTick's own header comment.
        triggerRealtimePulseTick();

        return { ok: okCount === results.length, durationMs, results };

    }
    catch(err){

        console.error(`[gmgn-scheduler] Batch FAILED: ${err.message}`, err);
        requestDiagnostics.endTick();
        lockGuard.release("ERROR");
        return null;

    }

}

function start(){

    console.log(`[gmgn-scheduler] Starting - running ${COLLECTORS.length} collectors every ${INTERVAL_MS / 1000}s`);

    runOnce();

    const timer = setInterval(runOnce, INTERVAL_MS);

    return {

        stop(){

            clearInterval(timer);

        }

    };

}

// Test-only reset - same convention as scheduler/heldPositionRefreshScheduler.js's
// own _resetForTest()/services/heldPositionMarketStore.js's clear().
function _resetForTest(){
    cooldownUntilMs = 0;
    earlyProbeAtMs = 0;
    earlyProbeAttempted = false;
}

module.exports = { start, runOnce, INTERVAL_MS, COLLECTORS, getCollectorHealth, getTickHealth, getPulseHealth, _resetForTest };
