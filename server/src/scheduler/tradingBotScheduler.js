// scheduler/tradingBotScheduler.js - Trading Bot Architecture Audit
// (Phase 9), extended for Sprint A Goal 2 (auth/multi-tenancy
// foundation). Ticks at a fixed, short interval; for every user whose
// bot is RUNNING and due for a cycle (trading_bot_config.scan_interval_seconds,
// per-user, user-adjustable at runtime without a server restart), runs
// tradingBotEngine.runCycle(userId, ...). A STOPPED/PAUSED bot costs
// nothing beyond the cheap state read every tick.
//
// Sprint A change: the old single global isRunning/lastCycleAt module
// state (correct for exactly one bot) is replaced by per-user tracking,
// so one user's cycle can never block or skip another's. tokens are
// computed ONCE per tick (not once per due user) and fanned out - the
// same "compute once, fan out" principle services/benchmarkRunner.js
// already proves for the Benchmark Harness, now applied here.
//
// WIRING FIX (Strategy Profile refactor's live-path gap, confirmed
// implementation bug): liveByAddress used to be computed ONCE per tick
// via liveRecommendationService's token_last_decision cache - but that
// cache is written by predictionValidationService.js against a single
// hardcoded "house" philosophy (STABLE), by design (see that file's own
// comment - the cache can only ever hold ONE profile's answer, so it is
// deliberately profile-blind and correct for the homepage/Decision
// Timeline it drives). Reusing that SAME profile-blind map here meant
// every non-STABLE profile's weights/tiers/acceleration_overrides
// (config/strategyProfileConfig.js) were silently discarded for entry
// scoring - a BASELINE/BALANCED/AGGRESSIVE user's entry gate
// (services/entryGateService.js) was fed STABLE's action/confidence no
// matter what their own strategy_profile was. Fixed the same way
// services/benchmarkRunner.js's computeProfileSignals already proved
// for the Benchmark Harness: score once per DISTINCT translated
// philosophy among this tick's due users (deduped by signature), never
// once globally against a single hardcoded philosophy. STABLE users are
// unaffected - STABLE's translated philosophy is all-default, so their
// computed signal is byte-identical to before this fix.

const liveRecommendationService = require("../services/liveRecommendationService");
const tradingBotRepository = require("../repositories/tradingBotRepository");
const tradingBotEngine = require("../services/tradingBotEngine");
const strategyProfileTranslator = require("../services/strategyProfileTranslator");
const scoringWorkerPool = require("../services/scoringWorkerPool");
// Fresh BUY Universe RFC (approved architecture: misty-floating-quasar.md):
// gmgnTokenRepository.getAllTokens() is no longer called directly from
// this file - freshUniverseService owns building the scoring/ranking
// universe now, so stale rows the collector stopped refreshing never
// reach scoring at all. tradingBotFreshUniverseSnapshotRepository
// records the collector->fresh-universe stage of the funnel per tick -
// the one stage that had zero observability before this sprint.
const freshUniverseService = require("../services/freshUniverseService");
const tradingBotFreshUniverseSnapshotRepository = require("../repositories/tradingBotFreshUniverseSnapshotRepository");
// Arjuna V4 Phase 1 (Engine Stability): the shared watchdog primitive
// already used by 7 of 9 schedulers (gmgnTrendingScheduler.js etc) -
// this scheduler and exitEvaluationScheduler.js were the two that
// actually place/close trades and had NOT adopted it yet. See below for
// why that mattered.
const { createLockGuard } = require("../services/schedulerLockGuard");

const TICK_MS = 15000;

const lastCycleAtByUser = new Map(); // userId -> ms epoch of that user's last cycle
// userId -> ms epoch when that user's CURRENT cycle began (present only
// while a cycle is genuinely in flight). Was a bare Set before Arjuna V4
// Phase 1 - a wedged runCycle() for one user left that user permanently
// stuck in the set with no timeout, silently starving just that user's
// future cycles forever (never globally visible as "stuck"). Now a Map
// so isDue() can watchdog-clear an entry that's been in flight longer
// than TICK_STUCK_AFTER_MS, same bound used for the outer-tick watchdog
// below.
const userCycleStartedAt = new Map();

// BUY-halt root-cause fix (real production incident, 2026-07-31 15:11:51
// -> 2026-08-01: this exact scheduler's own tick() stopped running
// entirely - proven by every independently-scheduled table in the
// database (gmgn_tokens, gmgn_trenches, token_price_history,
// trading_bot_log - each fed by a DIFFERENT scheduler on a DIFFERENT
// interval) all going silent at the same moment, which only a dead/
// frozen process explains. trading_bot_state.status stayed 'RUNNING'
// the entire time - it is a static DB flag, never revalidated against
// whether a cycle is actually still happening - so nothing anywhere
// could tell "BUY stopped because every coin was rejected" apart from
// "BUY stopped because this scheduler's own tick() silently died",
// exactly the ambiguity the bug report asked to close. getTickHealth()
// below is read by services/health.js so a dead tick is a real, provable
// /health fact within one tick interval, not something that can only be
// discovered hours later by manually diffing timestamps across tables.
//
// Arjuna V4 Phase 1 (Engine Stability): detection alone wasn't enough -
// audited production behavior showed a genuinely wedged tick's own
// currentTickStartedAt got silently RESET every 15s by the next
// setInterval firing (this scheduler had no reentrancy guard at the
// outer-tick level), masking the original hang indefinitely instead of
// ever surfacing as `stuck`. Replacing the hand-rolled bookkeeping with
// the shared lock guard fixes this: tryAcquire() returning false on an
// overlapping fire means a wedged tick's clock is never reset by a later
// one, AND its own watchdog force-releases the lock past maxDurationMs
// so a new tick can start again without a manual restart.
let lastTickError = null;

// Generous relative to a real tick (scoring + fan-out for every due
// user) - same "generous multiple of an established real cadence"
// convention health.js's own STALE_AFTER_SECONDS already uses (3x the
// producer's own interval). Reused below as BOTH the outer-tick lock
// guard's watchdog ceiling AND the per-user cycle watchdog bound - one
// traceable number, comfortably under the <60s auto-recovery ceiling.
const TICK_STUCK_AFTER_MS = 3 * TICK_MS;

const lockGuard = createLockGuard("trading-bot-scheduler", { maxDurationMs: TICK_STUCK_AFTER_MS });

function getTickHealth(){
    const health = lockGuard.getHealth();
    const secondsSinceLastFinish = health.lastFinishedAt != null ? Math.round((Date.now() - Date.parse(health.lastFinishedAt)) / 1000) : null;
    const nextTickEtaSeconds = (!health.isRunning && secondsSinceLastFinish != null)
        ? Math.max(0, Math.round(TICK_MS / 1000 - secondsSinceLastFinish))
        : null;
    return {
        currentTickStartedAt: health.startedAt,
        lastTickFinishedAt: health.lastFinishedAt,
        lastTickDurationMs: health.lastDurationMs,
        lastTickError,
        // "FINISHED" | "ERROR" | "WATCHDOG_RELEASED" | null (never ticked
        // yet) - same field gmgnTrendingScheduler.js's own getTickHealth()
        // already exposes, so a tick that had to be force-released by the
        // watchdog (as opposed to finishing or throwing normally) is a
        // real, visible fact on the dashboard, not indistinguishable from
        // a clean finish.
        lastOutcome: health.lastOutcome,
        secondsSinceLastFinish,
        // Never having finished a tick yet (fresh process start) is not
        // itself "stuck" - only a tick that started and never returned
        // within TICK_STUCK_AFTER_MS is.
        stuck: health.stuck,
        nextTickEtaSeconds,
        // userIds whose OWN cycle has been in flight longer than
        // TICK_STUCK_AFTER_MS right now - real-time, not force-cleared
        // by this read-only getter (the actual clear happens the next
        // time isDue() checks that user, at most one tick interval away).
        stuckUsers: getStuckUserIds()
    };
}

function getStuckUserIds(){
    const now = Date.now();
    const stuck = [];
    for(const [userId, startedAt] of userCycleStartedAt){
        if(now - startedAt > TICK_STUCK_AFTER_MS) stuck.push(userId);
    }
    return stuck;
}

function isDue(userId, now){

    const inFlightSince = userCycleStartedAt.get(userId);

    if(inFlightSince != null){

        // Arjuna V4 Phase 1 (Engine Stability): previously an unconditional
        // `return false` forever while this user was "in flight" - a
        // genuinely wedged runCycle() (never-resolving await) permanently
        // starved just that one user's future cycles, with no bound and
        // no visible signal. Same TICK_STUCK_AFTER_MS bound as the outer
        // tick's own lock guard watchdog.
        if((now - inFlightSince) > TICK_STUCK_AFTER_MS){
            console.error(`[trading-bot-scheduler] user=${userId} WATCHDOG: cycle in-flight for longer than ${TICK_STUCK_AFTER_MS}ms - force-clearing so this user is never permanently stuck`);
            userCycleStartedAt.delete(userId);
        }
        else{
            return false;
        }

    }

    const config = tradingBotRepository.getConfig(userId);
    const lastCycleAt = lastCycleAtByUser.get(userId) || 0;
    return (now - lastCycleAt) >= config.scan_interval_seconds * 1000;
}

// ASYNC (Sprint 2): tradingBotEngine.runCycle() now performs real
// execution I/O for the Founder wallet in LIVE mode, so it returns a
// Promise. userCycleStartedAt is set/deleted around the awaited call
// exactly as before (previously a bare Set) - the only change is that
// "in flight" now correctly spans the real network round-trip too, not
// just the synchronous scan.
async function runUserCycle(userId, tokens, liveByAddress){

    userCycleStartedAt.set(userId, Date.now());
    lastCycleAtByUser.set(userId, Date.now());

    try{

        const result = await tradingBotEngine.runCycle(userId, tokens, liveByAddress);

        // BUG FOUND DURING THE original Phase 9 audit dry run: runCycle()
        // returns two different shapes - {skipped: true, reason} when the
        // WHOLE cycle is skipped (bot not RUNNING, or LIVE mode refused),
        // vs {scanned, opened, closed, skipped: <count>, skipReasons} on a
        // real completed cycle, where `skipped` is a per-TOKEN count, not
        // a boolean. Check the actual shape (result.reason), never a
        // shared field name. LIVE_MODE_NOT_AUTHORIZED (Sprint 2 rename of
        // the old LIVE_MODE_NOT_IMPLEMENTED) is the same kind of whole-
        // cycle skip, logged already by runCycle() itself via insertLog -
        // no need to also console.log it here.
        if(result.reason !== "NOT_RUNNING" && result.reason !== "LIVE_MODE_NOT_AUTHORIZED"){

            console.log(
                `[trading-bot-scheduler] user=${userId} scanned=${result.scanned} opened=${result.opened} closed=${result.closed} skipped=${result.skipped}`
            );

        }

    }
    catch(err){

        console.error(`[trading-bot-scheduler] user=${userId} FAILED: ${err.message}`, err);

    }
    finally{

        userCycleStartedAt.delete(userId);

    }

}

// Deterministic signature of exactly the fields that affect SCORING -
// two users whose translated philosophy serializes identically (e.g.
// two different users both on STABLE) are the same "distinct profile"
// for computeLiveByAddressForPhilosophy's dedup below. Mirrors
// services/benchmarkRunner.js's own profileKeyFor.
function profileKeyFor(philosophy){
    return JSON.stringify(philosophy);
}

// Builds this tick's "live-shaped" per-token map for ONE philosophy,
// bypassing liveRecommendationService/token_last_decision entirely -
// that table can only ever hold ONE profile's answer (predictionValidationService.js's
// "house" STABLE cache), so it structurally cannot represent N
// simultaneous profile views. Structural exclusion (dead/dumped status)
// is still applied and is identical for every profile, matching the
// Constitution's Hard Reject requirement; Quality Gate is deliberately
// NOT applied here - it's a soft, profile-tunable filter checked
// downstream, per-user, by entryGateService.evaluateEntry(). Mirrors
// services/benchmarkRunner.js's computeProfileSignals inner loop
// exactly, minus that file's benchmark-only funnel/sightings bookkeeping.
//
// Ranking-priority fix (this token's own real acceleration signal was
// being computed HERE and then thrown away, forcing
// opportunityPriorityService.js/emiService.js to fall back to reading
// prediction_history - the STABLE-only house cache - for "how fresh is
// this candidate," which is meaningless for a profile whose real scoring
// never touches that table. Carrying signal.acceleration through fixes
// candidate ORDERING without touching the entry gate, tiers, or
// candidate count at all - see tradingBotEngine.js's orderCandidates.
async function computeLiveByAddressForPhilosophy(tokens, philosophy){

    const signals = await scoringWorkerPool.scoreTokens(tokens, philosophy);
    const liveMap = new Map();

    for(let i = 0; i < tokens.length; i++){

        const token = tokens[i];
        const structural = liveRecommendationService.computeStructuralExclusion(token);

        if(structural.excluded){
            liveMap.set(token.token_address, {
                action: "AVOID", confidence: 0, risk: "HIGH",
                excludeFromTrending: true, exclusionReason: structural.reason,
                hasDecision: false, decayFraction: 0, tokenStatus: structural.tokenStatus,
                acceleration: null
            });
            continue;
        }

        const signal = signals[i];
        liveMap.set(token.token_address, {
            action: signal.action, confidence: signal.confidence, risk: signal.risk,
            excludeFromTrending: false, exclusionReason: null,
            hasDecision: true, decayFraction: 1,
            participantScore: signal.participantScore, marketHealth: signal.marketHealth,
            // Live Decision Center / Signal Center sprint: the max
            // denominators for the two scores above - fixed engine
            // constants (config/scoringConfig.js), carried through here so
            // Position Detail's Confidence Breakdown can recompute
            // participantPct/marketPct without importing the engine
            // itself.
            participantMax: signal.participantMax, marketHealthMax: signal.marketHealthMax,
            tokenStatus: structural.tokenStatus,
            acceleration: signal.acceleration,
            // Trust/UX sprint: the full module-by-module breakdown and
            // real reasons researchEngineFactory.js already computes -
            // was being discarded right here, exactly like acceleration
            // used to be before the ranking-priority fix above. Flows
            // through entryGateService/tradeManager.openPosition
            // untouched (live is passed by reference the whole way) so
            // a real position can finally explain itself later.
            reasons: signal.reasons, breakdown: signal.breakdown,
            // Live Decision Center / Signal Center sprint: same shape of
            // fix, one more time - riskReasons/freshnessPenalty already
            // computed by researchEngineFactory.js to produce `risk`/
            // `confidence` themselves, previously discarded right here.
            riskReasons: signal.riskReasons, freshnessPenalty: signal.freshnessPenalty,
            // FINAL PRODUCTION SPRINT P0: the real momentum-phase
            // classification (see intelligence/market/momentumPhase.js) -
            // same "computed then discarded" fix as riskReasons/
            // acceleration above, flows through to tradeManager.js's
            // Decision Snapshot (breakdown_json) so every real BUY can be
            // explained by which phase Arjuna believed the token was in.
            momentumPhase: signal.momentumPhase, momentumPhaseFacts: signal.momentumPhaseFacts
        });

    }

    return liveMap;

}

async function runTick(){

    const runningUserIds = tradingBotRepository.findRunningUserIds();
    if(!runningUserIds.length) return;

    const now = Date.now();
    const dueUserIds = runningUserIds.filter(userId => isDue(userId, now));
    if(!dueUserIds.length) return;

    // Compute the candidate universe ONCE this tick, not once per due
    // user - still shared/global regardless of tenant, only the
    // SCORING pass below (which genuinely depends on each user's own
    // strategy_profile) is no longer collapsed onto a single hardcoded
    // philosophy.
    //
    // Fresh BUY Universe RFC: freshUniverseService.getBuyCandidateUniverse()
    // replaces the old inline getAllTokens().filter(market_cap>0) - same
    // market-cap floor, now ALSO excluding rows the collector stopped
    // refreshing (stale market snapshots that used to get scored/ranked
    // and then die at entryGateService's STALE_MARKET_DATA reject
    // anyway). One snapshot row recorded per tick for the funnel report
    // (services/tradingBotService.js's getBottleneckReport).
    const { tokens, collectorTotalCount, freshUniverseCount, maxAgeSeconds, minMarketCap } = freshUniverseService.getBuyCandidateUniverse();

    tradingBotFreshUniverseSnapshotRepository.insertSnapshot({ collectorTotalCount, freshUniverseCount, maxAgeSeconds, minMarketCap });

    console.log(`[trading-bot-scheduler] fresh universe: collector=${collectorTotalCount} fresh=${freshUniverseCount}`);

    // Group this tick's due users by their OWN translated philosophy -
    // dedup'd so N users on the same profile still score once, not N
    // times (same principle services/benchmarkRunner.js already proves).
    const profileKeyByUser = new Map();
    const philosophyByProfileKey = new Map();

    for(const userId of dueUserIds){
        const botConfig = tradingBotRepository.getConfig(userId);
        const philosophy = strategyProfileTranslator.translate(botConfig).philosophy;
        const key = profileKeyFor(philosophy);
        profileKeyByUser.set(userId, key);
        if(!philosophyByProfileKey.has(key)) philosophyByProfileKey.set(key, philosophy);
    }

    // Sequential is fine here - services/scoringWorkerPool.js runs on
    // ONE persistent worker (not a pool), so awaiting these one at a
    // time costs nothing extra a Promise.all over the same worker
    // wouldn't already serialize internally.
    for(const [key, philosophy] of philosophyByProfileKey){

        let liveByAddress;
        try{
            liveByAddress = await computeLiveByAddressForPhilosophy(tokens, philosophy);
        }
        catch(err){
            console.error(`[trading-bot-scheduler] scoring FAILED for profile signature=${key}: ${err.message}`, err);
            continue; // this tick's users on this profile simply get no cycle - never trade on a fabricated/partial signal
        }

        for(const [userId, userKey] of profileKeyByUser){
            if(userKey !== key) continue;
            runUserCycle(userId, tokens, liveByAddress);
        }

    }

}

// BUY-halt root-cause fix: thin wrapper around runTick() (the actual,
// unchanged scan/score/fan-out logic above) whose only job is to make
// this scheduler's own liveness a real, always-updated fact - the lock
// guard's startedAt is set BEFORE runTick() does anything, so even a
// runTick() that throws or never resolves still leaves a real,
// queryable "this is when it last started" behind for getTickHealth()/
// services/health.js to report. See this file's own header comment on
// TICK_STUCK_AFTER_MS above for the incident this closes.
//
// Arjuna V4 Phase 1 (Engine Stability): tryAcquire() returning false
// means a PREVIOUS tick is still genuinely in flight - this tick is
// skipped outright (never calls runTick(), never resets any clock),
// which is what actually fixes the original masking bug. If the
// previous tick really is wedged, the lock guard's own watchdog
// force-releases it after TICK_STUCK_AFTER_MS regardless, so a future
// tick can always acquire again without a manual restart.
async function tick(){

    if(!lockGuard.tryAcquire()){

        console.warn(`[trading-bot-scheduler] Skipped: previous tick still in progress (${new Date().toISOString()})`);
        return;

    }

    try{

        await runTick();
        lastTickError = null;
        lockGuard.release("FINISHED");

    }
    catch(err){

        lastTickError = err.message;
        lockGuard.release("ERROR");
        throw err; // unchanged behavior - start()'s own .catch() still logs it

    }

}

function start(){

    console.log(`[trading-bot-scheduler] Starting - checking every ${TICK_MS / 1000}s for any RUNNING user's bot due for its own cycle`);

    // tick() is now async (the per-distinct-profile scoring pass it
    // awaits) - setInterval never awaits its callback, so a rejection
    // must be caught here explicitly, same fire-and-forget contract
    // runUserCycle() already has for its own errors.
    const timer = setInterval(() => { tick().catch(err => console.error("[trading-bot-scheduler] tick FAILED", err)); }, TICK_MS);

    return { stop(){ clearInterval(timer); } };

}

// tick is exported alongside start purely for this file's own regression
// test (tradingBotScheduler.test.js) - proves the per-distinct-profile
// wiring fix, same convention services/tradingBotEngine.js already uses
// for orderCandidates. No other module calls it directly.
//
// getTickHealth is exported for services/health.js - see this file's own
// header comment on currentTickStartedAt for why this scheduler's own
// liveness needed to become a real, externally-checkable fact.
module.exports = { start, tick, getTickHealth, TICK_MS };
