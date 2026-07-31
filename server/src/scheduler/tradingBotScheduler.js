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

const TICK_MS = 15000;

const lastCycleAtByUser = new Map(); // userId -> ms epoch of that user's last cycle
const userCycleInFlight = new Set(); // userId currently mid-cycle - so one user's slow cycle can't overlap ITSELF; never blocks another user's

function isDue(userId, now){
    if(userCycleInFlight.has(userId)) return false;
    const config = tradingBotRepository.getConfig(userId);
    const lastCycleAt = lastCycleAtByUser.get(userId) || 0;
    return (now - lastCycleAt) >= config.scan_interval_seconds * 1000;
}

// ASYNC (Sprint 2): tradingBotEngine.runCycle() now performs real
// execution I/O for the Founder wallet in LIVE mode, so it returns a
// Promise. userCycleInFlight is added/deleted around the awaited call
// exactly as before - the only change is that "in flight" now correctly
// spans the real network round-trip too, not just the synchronous scan.
async function runUserCycle(userId, tokens, liveByAddress){

    userCycleInFlight.add(userId);
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

        userCycleInFlight.delete(userId);

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
            riskReasons: signal.riskReasons, freshnessPenalty: signal.freshnessPenalty
        });

    }

    return liveMap;

}

async function tick(){

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

    // TEMPORARY DIAGNOSTIC LOGGING - remove once snapshot insertion is
    // confirmed running in production. No try/catch here on purpose: if
    // insertSnapshot() throws, PM2 must print the real stack trace.
    console.log(`[trading-bot-scheduler] DIAG about to insertSnapshot: collectorTotalCount=${collectorTotalCount} freshUniverseCount=${freshUniverseCount} maxAgeSeconds=${maxAgeSeconds} minMarketCap=${minMarketCap}`);
    tradingBotFreshUniverseSnapshotRepository.insertSnapshot({ collectorTotalCount, freshUniverseCount, maxAgeSeconds, minMarketCap });
    console.log("[trading-bot-scheduler] DIAG Fresh universe snapshot inserted successfully.");

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
module.exports = { start, tick };
