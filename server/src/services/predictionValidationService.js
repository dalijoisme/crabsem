// services/predictionValidationService.js - the AI Validation
// Framework / Real-Time Decision Engine. Run every minute by
// scheduler/predictionValidationScheduler.js. Four real jobs:
//
//   1. evaluateAndRecordDecisions() - for EVERY token, re-run the
//      active production engine and decide (via the trigger-rule
//      engine below) whether the result is informative enough to
//      record as a NEW, immutable row in prediction_history (the
//      Decision Log). A token can receive as many decision rows as its
//      real signal history warrants - see PIPELINE REDESIGN below.
//
//   2. updateOpenTradePositions() - for every OPEN position in
//      trade_positions (NOT prediction_history - see redesign), replay
//      the REAL recorded price/market-cap history since it opened to
//      find whether TP or SL was touched FIRST, and compute real
//      MFE/MAE across the full observed range.
//
//   3. recordTimelineSnapshots() - unchanged in concept: once each real
//      30m/1h/2h/4h/8h/24h boundary has elapsed since a decision was
//      recorded, record the real observed price/MC at that point.
//
//   4. Position lifecycle (folded into job 1): decides whether a
//      qualifying decision should open a new position, leave an
//      existing one alone, or close one early on a genuine signal
//      reversal. See "OPEN PREDICTIONS POLICY" below for the exact
//      rule and why.
//
// =====================================
// PIPELINE REDESIGN (approved architecture, implemented here)
// =====================================
// Root cause fixed: prediction_history used to conflate TWO different
// jobs under one row and one UNIQUE(token_address) constraint - being
// the engine's decision log, AND being the position tracker. That
// constraint made sense for "only one open position per token" but was
// wrong for "the engine should be able to keep re-evaluating a token
// forever" - so the engine looked static even while running live.
//
// Fix (migration 017): prediction_history is now a pure, append-only
// DECISION LOG (no more UNIQUE constraint) - every trigger-worthy
// re-evaluation gets its own permanent row. trade_positions is a new,
// separate table that keeps the "one OPEN position per token, ever"
// guarantee, enforced by a real partial unique index
// (idx_trade_positions_one_open_per_token), completely independent of
// how many decision rows exist for that token.
//
// Backward compatibility: every OLD read function in
// predictionHistoryRepository.js (findOpen/findClosed/countsByStatus/
// etc.) keeps returning correct answers because trade_positions'
// tracking updates are mirrored back onto the ONE prediction_history
// row that opened the position (see tradePositionRepository.js) -
// nothing anywhere else in the app had to change to keep working.
//
// =====================================
// OPEN PREDICTIONS POLICY (the "update tracking vs close-and-reopen"
// decision the architecture proposal asked me to make and explain)
// =====================================
// CHOICE: an OPEN position is left running toward its OWN original
// target/stop, no matter how many new decision rows get recorded for
// that same token in the meantime - EXCEPT when a new decision is a
// genuine reversal (the active engine's own real "AVOID" recommendation
// while a position is open), which closes the position early with
// close_reason 'Signal Reversed'.
//
// WHY: (1) closing and reopening on every recommendation change would
// reset entry price/MFE/MAE artificially, destroying the statistical
// validity of "how did this trade actually do" - exactly the kind of
// spam this redesign is supposed to prevent, not add. (2) The exit
// strategy currently in production (Fixed TP15, validated via the
// Engine League + Real Capital Validation Tournament) deserves to be
// tested honestly to its own real conclusion, not interrupted every
// time confidence wobbles a few points. (3) "AVOID" is the one signal
// unambiguous enough to justify an early exit - it is the SAME real,
// already-computed field the active engine produces, not a new metric.

const config = require("../config/predictionValidationConfig");
const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");
const predictionHistoryRepository = require("../repositories/predictionHistoryRepository");
const predictionTimelineRepository = require("../repositories/predictionTimelineRepository");
const tradePositionRepository = require("../repositories/tradePositionRepository");
const tokenLastDecisionRepository = require("../repositories/tokenLastDecisionRepository");
const decisionCycleLogRepository = require("../repositories/decisionCycleLogRepository");
const productionEngineResolver = require("./productionEngineResolver");
const scoringWorkerPool = require("./scoringWorkerPool");
const tradePlanService = require("./tradePlanService");
const qualityGateService = require("./qualityGateService");
const strategyProfileTranslator = require("./strategyProfileTranslator");
const strategyProfileConfig = require("../config/strategyProfileConfig");

function toSqliteTimestamp(date){
    return date.toISOString().slice(0, 19).replace("T", " ");
}

function parseSqliteTimestamp(ts){
    return new Date(`${String(ts).replace(" ", "T")}Z`).getTime();
}

// =====================================
// COOPERATIVE YIELDING (performance milestone - event-loop starvation
// fix). This file's three per-record loops (evaluateAndRecordDecisions'
// per-token loop, updateOpenTradePositions' per-position loop,
// recordTimelineSnapshots' per-prediction loop) used to run thousands
// of iterations back-to-back with zero pause, monopolizing the single
// Node.js event loop for 40-110+ seconds at a time - measured, not
// hypothesized, blocking the GMGN collector's own timers, the Trading
// Bot scheduler, and incoming HTTP requests (including the Benchmark
// Harness's own Admin API) for that entire span.
//
// yieldToEventLoop() hands control back via setImmediate() - the
// event-loop phase that runs right after any pending I/O callbacks,
// before the next timer tick - so those starved timers/requests get a
// fair turn. This is scheduling ONLY: every per-record computation, DB
// read/write, and the ORDER records are processed in is byte-for-byte
// identical to before - only WHEN control briefly returns to the event
// loop between whole batches has changed. Production V2
// (config/scoringConfig.js, services/researchEngineFactory.js,
// services/productionEngineV2.js) is never touched - the scoring logic
// itself is unchanged. The single `analyzeTokens(tokens)` call below
// still runs exactly once per cycle, but (Root Cause Analysis fix) now
// goes through services/scoringWorkerPool.js, off this thread entirely,
// instead of the direct synchronous call this comment used to describe -
// that call was the actual proven source of event-loop starvation this
// yielding mechanism was designed around; this batch-loop's own
// yielding remains a real, separate, complementary safeguard for the
// per-record work below.
function yieldToEventLoop(){
    return new Promise(resolve => setImmediate(resolve));
}

// RATE_LIMIT_BANNED incident follow-up (2026-08-06, live VPS): with
// gmgn_tokens grown to 30,636 rows, one single scoringWorkerPool.scoreTokens()
// call for ALL of them measured ~26s in isolation on production
// (diagnostic script, real DB) - and prediction-validation-scheduler's
// own live logs showed gmgn-scheduler's WATCHDOG force-releasing its
// lock every tick for 60+ straight minutes during the exact same
// window, with gmgn_tokens.updated_at frozen the whole time (no
// collector progress at all). Root cause: postMessage() to/from the
// worker structured-clones the tokens/signals payload SYNCHRONOUSLY on
// THIS thread (see scoringWorkerPool.js) - for 30k+ objects that is a
// real, single, uninterrupted span this thread cannot service any other
// timer during, including gmgn-scheduler's own AbortSignal.timeout
// (authClient.js, 15s) callbacks - a delayed timer callback effectively
// extends that collector call's real wall-clock hang time well past its
// nominal bound. Splitting into smaller worker round-trips with a yield
// between each does NOT change which tokens get scored, their order, or
// the returned signal for any of them (scoringWorkerPool.scoreTokens is
// a pure function of the tokens it's given) - only how many separate
// synchronous bursts the total serialize/deserialize cost is spread
// across. SCORE_BATCH_SIZE is a starting point (same "not validated,
// tunable" framing as EVENT_LOOP_YIELD_BATCH_SIZE above) - large enough
// to keep worker round-trip overhead low, small enough that no single
// burst should be noticeable to a waiting HTTP request.
let SCORE_BATCH_SIZE = 1000;

async function scoreTokensInBatches(tokens, philosophy){

    const signals = new Array(tokens.length);

    for(let i = 0; i < tokens.length; i += SCORE_BATCH_SIZE){

        const chunk = tokens.slice(i, i + SCORE_BATCH_SIZE);
        const chunkSignals = await scoringWorkerPool.scoreTokens(chunk, philosophy);

        for(let j = 0; j < chunkSignals.length; j++) signals[i + j] = chunkSignals[j];

        if(i + SCORE_BATCH_SIZE < tokens.length) await yieldToEventLoop();

    }

    return signals;

}

// Test-only override - same convention as heldPositionRefreshScheduler.js's
// own _setCooldownStateForTest() - lets a test force a small batch size
// against a handful of real tokens instead of needing 1000+ rows to
// prove the chunking/reassembly logic itself.
function _setScoreBatchSizeForTest(n){
    SCORE_BATCH_SIZE = n;
}

// Deliberately simple, unvalidated starting point (same honest framing
// as TRIGGERS/QUALITY_GATE elsewhere in this file) - small enough that
// no single uninterrupted synchronous block should run long enough to
// be noticeable to a waiting HTTP request, large enough that yielding
// overhead stays negligible next to real work. See the performance
// report for the real, measured effect of this value.
const EVENT_LOOP_YIELD_BATCH_SIZE = 150;

// =====================================
// QUALITY GATE (Risk Reduction) - hard rejects using ONLY real,
// already-collected fields. Operates at the PIPELINE level, never
// touching the active engine's own scoring/weights. Thresholds are
// deliberately set at EXTREME levels (reject only the clearest cases),
// per the approved proposal's risk-analysis note that these are
// starting points, not validated final values.
// =====================================

// Quality Gate moved to qualityGateService.js (Prediction Pipeline
// Live-Recommendation sprint) so tokenQueryService.js's homepage/
// trending surface can hard-exclude the exact same real rug/
// manipulation cases as the decision pipeline, instead of drifting out
// of sync with a second copy of these thresholds.
const passesQualityGate = qualityGateService.passesQualityGate;

// =====================================
// TRIGGER-RULE ENGINE - decides whether a re-evaluation is informative
// enough to record as a new decision row. Thresholds are explicit
// starting points (see architecture proposal Section 1) - tunable
// after real throughput is observed, not claimed as validated.
// =====================================

const TRIGGERS = {
    confidenceDelta: 15,
    participantScoreDelta: 10,
    marketHealthDelta: 15,
    volumeSpikeMultiple: 3,
    liquidityDeltaPct: 30,
    marketCapDeltaPct: 25,
    smartMoneyDeltaFraction: 0.4,
    whaleDeltaFraction: 0.4,
    refreshTimeoutMinutes: 25,
    cooldownMinutes: 4
};

function evaluateTriggers(signal, token, last){
    if(!last) return { fire: true, reason: "FIRST_DECISION_FOR_TOKEN" };

    if(signal.action !== last.last_recommendation){
        return { fire: true, reason: `RECOMMENDATION_CHANGED_${last.last_recommendation}_TO_${signal.action}` };
    }

    const minutesSinceLast = (Date.now() - parseSqliteTimestamp(last.last_decision_at)) / 60000;

    if(minutesSinceLast < TRIGGERS.cooldownMinutes){
        return { fire: false, reason: "COOLDOWN_ACTIVE" };
    }

    if(last.last_confidence != null && signal.confidence != null &&
       Math.abs(signal.confidence - last.last_confidence) >= TRIGGERS.confidenceDelta){
        return { fire: true, reason: "CONFIDENCE_CHANGED_SIGNIFICANTLY" };
    }

    if(last.last_participant_score != null &&
       Math.abs(signal.participantScore - last.last_participant_score) >= TRIGGERS.participantScoreDelta){
        return { fire: true, reason: "PARTICIPANT_SCORE_CHANGED_SIGNIFICANTLY" };
    }

    if(last.last_market_health != null &&
       Math.abs(signal.marketHealth - last.last_market_health) >= TRIGGERS.marketHealthDelta){
        return { fire: true, reason: "MARKET_HEALTH_CHANGED_SIGNIFICANTLY" };
    }

    const smScore = signal.breakdown?.participant?.smartMoney;
    if(smScore?.hasData && last.last_smart_money_score != null && smScore.max > 0){
        const deltaFraction = Math.abs(smScore.score - last.last_smart_money_score) / smScore.max;
        if(deltaFraction >= TRIGGERS.smartMoneyDeltaFraction) return { fire: true, reason: "SMART_MONEY_CHANGED_SIGNIFICANTLY" };
    }

    const whaleScore = signal.breakdown?.participant?.whale;
    if(whaleScore?.hasData && last.last_whale_score != null && whaleScore.max > 0){
        const deltaFraction = Math.abs(whaleScore.score - last.last_whale_score) / whaleScore.max;
        if(deltaFraction >= TRIGGERS.whaleDeltaFraction) return { fire: true, reason: "WALLET_CHANGED_SIGNIFICANTLY" };
    }

    const volume1h = token.volume_1h != null ? Number(token.volume_1h) : null;
    if(volume1h != null && last.last_volume_1h != null && last.last_volume_1h > 0 &&
       volume1h / last.last_volume_1h >= TRIGGERS.volumeSpikeMultiple){
        return { fire: true, reason: "VOLUME_SPIKE" };
    }

    const liquidity = token.liquidity != null ? Number(token.liquidity) : null;
    if(liquidity != null && last.last_liquidity != null && last.last_liquidity > 0){
        const deltaPct = Math.abs((liquidity - last.last_liquidity) / last.last_liquidity) * 100;
        if(deltaPct >= TRIGGERS.liquidityDeltaPct) return { fire: true, reason: "LIQUIDITY_CHANGED_SIGNIFICANTLY" };
    }

    const marketCap = Number(token.market_cap) || null;
    if(marketCap != null && last.last_market_cap != null && last.last_market_cap > 0){
        const deltaPct = Math.abs((marketCap - last.last_market_cap) / last.last_market_cap) * 100;
        if(deltaPct >= TRIGGERS.marketCapDeltaPct) return { fire: true, reason: "MARKET_CAP_CHANGED_SIGNIFICANTLY" };
    }

    if(minutesSinceLast >= TRIGGERS.refreshTimeoutMinutes){
        return { fire: true, reason: "FIXED_REFRESH_TIMEOUT" };
    }

    return { fire: false, reason: "NO_SIGNIFICANT_CHANGE" };
}

// =====================================
// 1. EVALUATE AND RECORD DECISIONS (was createNewPredictions)
// =====================================

function buildWalletSummary(signal){
    return {
        smartMoneyWalletCount: signal.intelligence.smartMoney.activities?.length || 0,
        kolWalletCount: signal.intelligence.kol.activities?.length || 0,
        devWalletIdentified: signal.intelligence.devWallet.hasData,
        walletStatsChecked: signal.intelligence.walletStatsChecked || 0
    };
}

// RATE_LIMIT_BANNED incident follow-up (2026-08-06, live VPS): chunking
// the scoring call (previous commit) only changes WHEN the same total
// scoring work runs, never HOW MUCH there is - under real sustained
// load evaluateAndRecordDecisions still grew to 86-107s per cycle and
// gmgn-scheduler relapsed into its stuck-lock loop after only a ~2min
// recovery window. Real data: 96% of gmgn_tokens (29,428 of 30,674 rows
// at the time of this fix) had not been touched by ANY collector in 7+
// days - dead weight that can never realistically become a live BUY
// candidate through this account's own collector pipeline. Same root
// cause services/freshUniverseService.js's own "Fresh BUY Universe RFC"
// already fixed for tradingBotScheduler.js's sibling pipeline (see that
// file's header) - this decision-log pipeline never got the same fix.
//
// DECISION_SCAN_MAX_AGE_SECONDS is deliberately far more generous than
// entryGateService.js's own MAX_MARKET_DATA_AGE_SECONDS (120s, tuned
// for live BUY execution timing) - this is a decision/research LOG, not
// an execution gate, so it only needs to exclude tokens that are
// unambiguously dead, not merely a few minutes old. Real behavior
// change, approved (2026-08-06): a token with no collector update in
// 6+ hours stops getting FIXED_REFRESH_TIMEOUT's every-25-minute forced
// re-log - it was never a real trading candidate anyway, but the
// historical decision-log loses that completeness for dead tokens.
//
// Every OPEN position's token is unioned in regardless of this cutoff -
// held-position price refreshes (scheduler/heldPositionRefreshScheduler.js)
// write into services/heldPositionMarketStore.js, a SEPARATE cache,
// never back into gmgn_tokens.updated_at, so a token whose own
// trending-collector coverage lapsed could otherwise silently fall out
// of this scan and lose its close-on-AVOID-reversal safety net (see
// OPEN PREDICTIONS POLICY above) even while still being actively held.
const DECISION_SCAN_MAX_AGE_SECONDS = 6 * 60 * 60;

function getDecisionScanTokens(){

    const freshTokens = gmgnTokenRepository.getFreshTokens({ maxAgeSeconds: DECISION_SCAN_MAX_AGE_SECONDS, minMarketCap: 0 });
    const freshAddresses = new Set(freshTokens.map(t => t.token_address));

    const openOnlyTokens = [];

    for(const position of tradePositionRepository.findOpen()){

        if(freshAddresses.has(position.token_address)) continue;

        const token = gmgnTokenRepository.getTokenByAddress(position.token_address);

        if(token && token.market_cap != null && token.market_cap > 0) openOnlyTokens.push(token);

    }

    return [...freshTokens, ...openOnlyTokens];

}

async function evaluateAndRecordDecisions(){

    const cycleStartedAt = Date.now();

    const tokens = getDecisionScanTokens();

    if(!tokens.length) return { created: 0, scanned: 0, skipped: 0, skipReasons: {} };

    const activeEngine = productionEngineResolver.getActiveEngine();
    const activeVersion = productionEngineResolver.getActiveVersion();
    const activeVersionMeta = productionEngineResolver.REGISTRY[activeVersion];

    // Sprint A, Goal 2 (auth/multi-tenancy foundation): trading_bot_config
    // is now per-user (migration 035) - there is no longer one
    // unambiguous "the" config to drive this ONE shared decision-log
    // writer (this cache - token_last_decision/prediction_history - is
    // genuinely global infrastructure, read by every user's bot
    // regardless of their own strategy_profile choice, so it can't
    // itself become per-user without re-keying it, a bigger change
    // explicitly deferred - see the Sprint A plan). Fixed to a canonical
    // "house" profile instead: STABLE's translated philosophy is
    // all-default (see strategyProfileTranslator.js/strategyProfileConfig.js's
    // own comment), so this is a zero-behavior-change decoupling from
    // the old singleton read, not a scoring change. Each user's OWN
    // quality-gate/exit/cooldown/sizing config still applies fully and
    // independently at their own gate/exit time (services/tradeManager.js's
    // closeIfDue re-scores live, per-position, per-user) - only the
    // shared initial candidate discovery is house-wide.
    const engineParams = strategyProfileTranslator.translate(strategyProfileConfig.resolveProfile("STABLE"));
    // Root Cause Analysis fix: this used to be a direct, synchronous
    // activeEngine.analyzeTokens(...) call - the exact multi-second,
    // zero-yield-point call proven to starve the event loop (and with it
    // the live GMGN collector) for its entire duration. Routed through
    // scoringWorkerPool so the heavy scoring pass runs on a separate
    // thread instead of blocking this one.
    const signals = await scoreTokensInBatches(tokens, engineParams.philosophy);

    let created = 0, skipped = 0, recommendationChanges = 0, upgrades = 0, downgrades = 0;
    let positionsOpened = 0, positionsClosedOnReversal = 0;
    const skipReasons = {};
    const confidenceSum = { total: 0, count: 0 };

    const TIER_RANK = { "AVOID": 0, "HOLD": 1, "BUY": 2, "STRONG BUY": 3 };

    // Was tokens.forEach((token, i) => {...}) - converted to an indexed
    // for-loop ONLY so `continue`/await can be used for cooperative
    // yielding (see EVENT_LOOP_YIELD_BATCH_SIZE below). Every statement
    // inside, and the order tokens are visited in, is unchanged.
    for(let i = 0; i < tokens.length; i++){

        const token = tokens[i];
        const signal = signals[i];
        const last = tokenLastDecisionRepository.findByToken(token.token_address);

        const quality = passesQualityGate(token, engineParams.qualityGateOverrides);
        if(!quality.pass){
            skipped++;
            skipReasons[quality.reason] = (skipReasons[quality.reason] || 0) + 1;
            if((i + 1) % EVENT_LOOP_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
            continue;
        }

        const trigger = evaluateTriggers(signal, token, last);
        if(!trigger.fire){
            skipped++;
            skipReasons[trigger.reason] = (skipReasons[trigger.reason] || 0) + 1;
            if((i + 1) % EVENT_LOOP_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
            continue;
        }

        // Same readiness gate as before - gates whether a real trade
        // plan (and therefore a possible position) exists for this
        // decision. Unchanged from the pre-redesign behavior: HOLD can
        // pass this, AVOID never does.
        const readiness = tradePlanService.assessTradePlanReadiness(signal);
        const riskBands = readiness.ready ? activeEngine.buildRiskBands(token, signal, engineParams.exitOverrides) : null;

        const existingOpenPosition = tradePositionRepository.findOpenForToken(token.token_address);

        const predictionId = predictionHistoryRepository.insertPrediction({
            tokenAddress: token.token_address,
            tokenSymbol: token.symbol,
            recommendation: signal.action,
            score: signal.participantScore,
            confidence: signal.confidence,
            reasonJson: JSON.stringify(signal.reasons),
            entryPrice: Number(token.price) || null,
            entryMarketCap: Number(token.market_cap) || null,
            entryLiquidity: token.liquidity != null ? Number(token.liquidity) : null,
            entryVolume: token.volume_1h != null ? Number(token.volume_1h) : null,
            entryHolders: token.holders != null ? Number(token.holders) : null,
            walletSummaryJson: JSON.stringify(buildWalletSummary(signal)),
            tradePlanJson: riskBands ? JSON.stringify(riskBands) : null,
            targetPrice: riskBands ? riskBands.target.price : null,
            targetMarketCap: riskBands ? riskBands.target.marketCap : null,
            stopLossPrice: riskBands ? riskBands.stopLoss.price : null,
            stopLossMarketCap: riskBands ? riskBands.stopLoss.marketCap : null,
            predictionHorizonSeconds: config.defaultHorizonSeconds,
            engineVersion: activeVersion,
            engineName: activeVersionMeta.engineShortName,
            exitStrategy: activeVersionMeta.exitStrategyShortName,
            triggerReason: trigger.reason,
            changedFromRecommendation: last ? last.last_recommendation : null,
            changedFromConfidence: last ? last.last_confidence : null,
            initialStatus: (!existingOpenPosition && readiness.ready && riskBands) ? "OPEN" : "DECISION_ONLY"
        });

        created++;
        if(signal.confidence != null){ confidenceSum.total += signal.confidence; confidenceSum.count++; }

        if(last && signal.action !== last.last_recommendation){
            recommendationChanges++;
            const prevRank = TIER_RANK[last.last_recommendation] ?? 1;
            const newRank = TIER_RANK[signal.action] ?? 1;
            if(newRank > prevRank) upgrades++;
            else if(newRank < prevRank) downgrades++;
        }

        // ---- POSITION LIFECYCLE (see OPEN PREDICTIONS POLICY above) ----
        if(!existingOpenPosition && readiness.ready && riskBands){
            const result = tradePositionRepository.openPosition({
                tokenAddress: token.token_address, tokenSymbol: token.symbol,
                openedByPredictionId: predictionId,
                entryPrice: Number(token.price) || null, entryMarketCap: Number(token.market_cap) || null,
                entryLiquidity: token.liquidity != null ? Number(token.liquidity) : null,
                entryVolume: token.volume_1h != null ? Number(token.volume_1h) : null,
                entryHolders: token.holders != null ? Number(token.holders) : null,
                targetPrice: riskBands.target.price, targetMarketCap: riskBands.target.marketCap,
                stopLossPrice: riskBands.stopLoss.price, stopLossMarketCap: riskBands.stopLoss.marketCap,
                predictionHorizonSeconds: config.defaultHorizonSeconds
            });
            if(result.opened) positionsOpened++;
        } else if(existingOpenPosition && signal.action === "AVOID"){
            tradePositionRepository.closeOnSignalReversal(
                existingOpenPosition,
                Number(token.price) || existingOpenPosition.current_price,
                Number(token.market_cap) || existingOpenPosition.current_market_cap
            );
            positionsClosedOnReversal++;
        }

        tokenLastDecisionRepository.upsert({
            tokenAddress: token.token_address,
            lastPredictionId: predictionId,
            lastRecommendation: signal.action,
            lastConfidence: signal.confidence,
            lastParticipantScore: signal.participantScore,
            lastMarketHealth: signal.marketHealth,
            lastLiquidity: token.liquidity != null ? Number(token.liquidity) : null,
            lastMarketCap: Number(token.market_cap) || null,
            lastVolume1h: token.volume_1h != null ? Number(token.volume_1h) : null,
            lastSmartMoneyScore: signal.breakdown?.participant?.smartMoney?.score ?? null,
            lastWhaleScore: signal.breakdown?.participant?.whale?.score ?? null,
            lastRisk: signal.risk ?? null
        });

        if((i + 1) % EVENT_LOOP_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();

    }

    decisionCycleLogRepository.insertCycle({
        scanned: tokens.length, created, skipped,
        skipReasonsJson: JSON.stringify(skipReasons),
        avgConfidence: confidenceSum.count ? confidenceSum.total / confidenceSum.count : null,
        recommendationChanges, upgrades, downgrades,
        positionsOpened, positionsClosedOnReversal,
        durationMs: Date.now() - cycleStartedAt
    });

    return { created, scanned: tokens.length, skipped, skipReasons, recommendationChanges, upgrades, downgrades, positionsOpened, positionsClosedOnReversal };

}

// =====================================
// 2. UPDATE OPEN TRADE POSITIONS (was updateOpenPredictions) - real
// TP/SL/Expired + MFE/MAE, now against trade_positions.
// =====================================

function computeFailureReason(position, closeSnapshot, linkedPrediction){

    const f = config.failureAnalysis;

    const token = gmgnTokenRepository.getTokenByAddress(position.token_address);

    if(!token) return "Unknown";

    const liquidity = Number(token.liquidity) || 0;

    if(position.entry_liquidity && liquidity <= position.entry_liquidity * f.liquidityRemovedRatio){
        return "Liquidity Removal";
    }

    const holders = token.holders != null ? Number(token.holders) : null;

    if(position.entry_holders && holders != null && holders <= position.entry_holders * f.holderDeclineRatio){
        return "Holder Decline";
    }

    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;

    if(change1h != null && change1h <= f.momentumCollapsePct){
        return "Momentum Collapse";
    }

    const trenchesEntry = gmgnTrenchesRepository.findByTokenAddress(position.token_address);

    if(trenchesEntry?.net_buy_24h != null && Number(trenchesEntry.net_buy_24h) <= f.netDistributionUsd){
        if(trenchesEntry.smart_degen_count != null && Number(trenchesEntry.smart_degen_count) >= 3){
            return "Whale Distribution";
        }
        return "Smart Money Exit";
    }

    // "Developer Selling" deliberately not implemented - see original
    // engine-quality sprint's rejection of gmgn_tokens.raw_json.
    // creator_close as a discriminating real signal.

    return "Unknown";

}

function computeWinReason(position, linkedPrediction){

    const trenchesEntry = gmgnTrenchesRepository.findByTokenAddress(position.token_address);

    if(trenchesEntry?.net_buy_24h != null && Number(trenchesEntry.net_buy_24h) >= 500){
        if(trenchesEntry.smart_degen_count != null && Number(trenchesEntry.smart_degen_count) >= 3){
            return "Whale Accumulation";
        }
        return "Net Accumulation";
    }

    let walletSummary = null;

    try{ walletSummary = linkedPrediction?.wallet_summary_json ? JSON.parse(linkedPrediction.wallet_summary_json) : null; }
    catch(e){ /* real field parse failed - fall through, never guessed */ }

    if(walletSummary?.smartMoneyWalletCount > 0) return "Smart Money Involvement";

    if(walletSummary?.kolWalletCount > 0) return "KOL Involvement";

    if(linkedPrediction?.confidence != null && linkedPrediction.confidence >= 60) return "High Confidence Entry";

    return "Unknown";

}

function evaluatePosition(position){

    const rows = tokenPriceHistoryRepository.findRangeForToken(position.token_address, position.opened_at);

    const token = gmgnTokenRepository.getTokenByAddress(position.token_address);

    const series = rows.length
        ? rows
        : (token && token.market_cap != null ? [{ price: token.price, market_cap: token.market_cap, recorded_at: token.updated_at }] : []);

    if(!series.length) return null;

    const entryMc = position.entry_market_cap;

    let mfePct = position.mfe_pct || 0;
    let maePct = position.mae_pct || 0;
    let closeStatus = null;
    let closeSnapshot = null;

    for(const point of series){

        const mc = point.market_cap != null ? Number(point.market_cap) : null;

        if(mc == null || entryMc == null || entryMc <= 0) continue;

        const roiPct = ((mc - entryMc) / entryMc) * 100;

        if(roiPct > mfePct) mfePct = roiPct;
        if(roiPct < maePct) maePct = roiPct;

        if(closeStatus) continue;

        if(position.target_market_cap != null && mc >= position.target_market_cap){
            closeStatus = "TP_HIT";
            closeSnapshot = point;
        }
        else if(position.stop_loss_market_cap != null && mc <= position.stop_loss_market_cap){
            closeStatus = "SL_HIT";
            closeSnapshot = point;
        }

    }

    const latest = series[series.length - 1];
    const latestMc = latest.market_cap != null ? Number(latest.market_cap) : null;
    const currentRoiPct = (latestMc != null && entryMc) ? ((latestMc - entryMc) / entryMc) * 100 : null;
    const timeAliveSeconds = Math.round((Date.now() - parseSqliteTimestamp(position.opened_at)) / 1000);

    if(!closeStatus && position.prediction_horizon_seconds != null && timeAliveSeconds >= position.prediction_horizon_seconds){
        closeStatus = "EXPIRED";
        closeSnapshot = latest;
    }

    let closeReason = null;
    if(closeStatus){
        const linkedPrediction = predictionHistoryRepository.findById(position.opened_by_prediction_id);
        closeReason = closeStatus === "TP_HIT"
            ? computeWinReason(position, linkedPrediction)
            : computeFailureReason(position, closeSnapshot, linkedPrediction);
    }

    return {
        status: closeStatus || "OPEN",
        currentPrice: latest.price != null ? Number(latest.price) : null,
        currentMarketCap: latestMc,
        currentRoiPct,
        mfePct, maePct,
        timeAliveSeconds,
        closedAt: closeStatus ? toSqliteTimestamp(new Date()) : null,
        closeReason
    };

}

async function updateOpenTradePositions(){

    const open = tradePositionRepository.findOpen();

    let updated = 0, closed = 0;

    for(let i = 0; i < open.length; i++){

        const position = open[i];

        const tracking = evaluatePosition(position);

        if(tracking){

            tradePositionRepository.updateTracking(position, tracking);

            updated++;

            if(tracking.status !== "OPEN") closed++;

        }

        if((i + 1) % EVENT_LOOP_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();

    }

    return { checked: open.length, updated, closed };

}

// =====================================
// 3. PREDICTION TIMELINE - unchanged in concept; now naturally covers
// every decision row (not just position-opening ones), which is
// intentional - "how did price move after THIS decision" is meaningful
// regardless of whether a position was opened for it.
// =====================================

// SPRINT 12 (Arjuna V5) - ROOT CAUSE FIX: only predictions still young
// enough for at least one configured horizon to legitimately still be
// pending are worth re-scanning - see findRecentLite's own header
// comment for the real production incident this closes. 3600s slack
// covers this scheduler's own worst-case single-cycle delay plus a
// fresh boundary that just elapsed - reused below (2026-08-06 follow-up)
// as the width of each horizon's own narrow scan window, same
// reasoning, now applied per-horizon instead of once globally.
const TIMELINE_LOOKBACK_SLACK_SECONDS = 3600;

// RATE_LIMIT_BANNED incident follow-up (2026-08-06) - ROOT CAUSE FIX:
// the original version scanned EVERY prediction in the full 25h
// lookback window (findRecentLite) on EVERY ~60s cycle, then checked
// all 6 horizons against each - real measurement against production
// data found 491,317 rows in that window, and this phase alone took
// 60-85 seconds per run (the dominant cost left in this scheduler
// after the separate disk-bloat/retention fix). Almost all of that
// work was pure waste: a prediction whose horizon boundary passed
// hours ago either already got that horizon recorded on an earlier
// cycle, or (rare) will still be caught here as long as no run gap
// exceeds TIMELINE_LOOKBACK_SLACK_SECONDS - re-checking it AGAIN every
// single cycle for its entire 25h lifetime added nothing.
//
// Restructured per-horizon instead of per-prediction: for each of the 6
// configured horizons, only predictions whose OWN prediction_time falls
// in a narrow, bounded window - "old enough that this horizon just
// became due, recent enough it could plausibly still be unrecorded" -
// are worth checking THIS cycle. TIMELINE_LOOKBACK_SLACK_SECONDS (1h,
// already established elsewhere in this file for the same worst-case-
// delay reasoning) is reused as that window's width, so a prediction
// whose horizon boundary falls inside a ~1-hour band gets checked on
// several consecutive cycles (the SAME safety margin the original
// design had against a skipped/delayed run) before aging out - never
// re-scanned for its whole 25h lifetime like before. Net effect: the
// same 491K-row backlog becomes roughly (predictions/hour) x 6 narrow
// window queries instead of ALL of it x 6, independent of prediction
// history's own total size or age.
async function recordTimelineSnapshots(){

    let recorded = 0;
    let checked = 0;
    const now = Date.now();

    for(const h of config.timelineHorizons){

        // Anything with prediction_time < windowEnd already has this
        // horizon's boundary in the past (due); anything >= windowStart
        // is recent enough this horizon could plausibly still be
        // unrecorded for it (within the same slack every other lookback
        // in this file already uses).
        const windowEnd = toSqliteTimestamp(new Date(now - h.seconds * 1000));
        const windowStart = toSqliteTimestamp(new Date(now - (h.seconds + TIMELINE_LOOKBACK_SLACK_SECONDS) * 1000));

        const predictions = predictionHistoryRepository.findRecentLiteInWindow(windowStart, windowEnd);

        for(let i = 0; i < predictions.length; i++){

            const p = predictions[i];
            checked++;

            const existingHorizons = predictionTimelineRepository.findExistingHorizons(p.id);
            if(existingHorizons.has(h.label)) continue;

            const targetTimestamp = toSqliteTimestamp(new Date(parseSqliteTimestamp(p.prediction_time) + h.seconds * 1000));

            const point = tokenPriceHistoryRepository.findPriceAtOrAfter(p.token_address, targetTimestamp);

            if(!point || point.market_cap == null) continue;

            const full = predictionHistoryRepository.findById(p.id);

            const roiPct = (full.entry_market_cap && full.entry_market_cap > 0)
                ? ((Number(point.market_cap) - full.entry_market_cap) / full.entry_market_cap) * 100
                : null;

            const inserted = predictionTimelineRepository.insertSnapshot({
                predictionId: p.id,
                horizon: h.label,
                roiPct,
                marketCap: Number(point.market_cap),
                price: point.price != null ? Number(point.price) : null
            });

            if(inserted) recorded++;

            if(checked % EVENT_LOOP_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();

        }

    }

    return { recorded };

}

async function runCycle(){

    const t0 = Date.now();
    const createResult = await evaluateAndRecordDecisions();
    const t1 = Date.now();
    const updateResult = await updateOpenTradePositions();
    const t2 = Date.now();
    const timelineResult = await recordTimelineSnapshots();
    const t3 = Date.now();

    return {
        createResult, updateResult, timelineResult,
        durationMs: t3 - t0,
        phaseDurationsMs: {
            evaluateAndRecordDecisions: t1 - t0,
            updateOpenTradePositions: t2 - t1,
            recordTimelineSnapshots: t3 - t2
        }
    };

}

module.exports = {
    evaluateAndRecordDecisions, updateOpenTradePositions, recordTimelineSnapshots, runCycle,
    computeFailureReason, computeWinReason,
    // Backward-compatible aliases (old names, same behavior) in case
    // anything else in the codebase still imports the pre-redesign names.
    createNewPredictions: evaluateAndRecordDecisions,
    updateOpenPredictions: updateOpenTradePositions,
    scoreTokensInBatches, _setScoreBatchSizeForTest,
    getDecisionScanTokens, DECISION_SCAN_MAX_AGE_SECONDS
};
