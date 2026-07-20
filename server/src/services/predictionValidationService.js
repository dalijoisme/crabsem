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
const tradePlanService = require("./tradePlanService");
const qualityGateService = require("./qualityGateService");

function toSqliteTimestamp(date){
    return date.toISOString().slice(0, 19).replace("T", " ");
}

function parseSqliteTimestamp(ts){
    return new Date(`${String(ts).replace(" ", "T")}Z`).getTime();
}

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

function evaluateAndRecordDecisions(){

    const cycleStartedAt = Date.now();

    const tokens = gmgnTokenRepository.getAllTokens().filter(t => t.market_cap != null && t.market_cap > 0);

    if(!tokens.length) return { created: 0, scanned: 0, skipped: 0, skipReasons: {} };

    const activeEngine = productionEngineResolver.getActiveEngine();
    const activeVersion = productionEngineResolver.getActiveVersion();
    const activeVersionMeta = productionEngineResolver.REGISTRY[activeVersion];
    const signals = activeEngine.analyzeTokens(tokens);

    let created = 0, skipped = 0, recommendationChanges = 0, upgrades = 0, downgrades = 0;
    let positionsOpened = 0, positionsClosedOnReversal = 0;
    const skipReasons = {};
    const confidenceSum = { total: 0, count: 0 };

    const TIER_RANK = { "AVOID": 0, "HOLD": 1, "BUY": 2, "STRONG BUY": 3 };

    tokens.forEach((token, i) => {

        const signal = signals[i];
        const last = tokenLastDecisionRepository.findByToken(token.token_address);

        const quality = passesQualityGate(token);
        if(!quality.pass){
            skipped++;
            skipReasons[quality.reason] = (skipReasons[quality.reason] || 0) + 1;
            return;
        }

        const trigger = evaluateTriggers(signal, token, last);
        if(!trigger.fire){
            skipped++;
            skipReasons[trigger.reason] = (skipReasons[trigger.reason] || 0) + 1;
            return;
        }

        // Same readiness gate as before - gates whether a real trade
        // plan (and therefore a possible position) exists for this
        // decision. Unchanged from the pre-redesign behavior: HOLD can
        // pass this, AVOID never does.
        const readiness = tradePlanService.assessTradePlanReadiness(signal);
        const riskBands = readiness.ready ? activeEngine.buildRiskBands(token, signal) : null;

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

    });

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

function updateOpenTradePositions(){

    const open = tradePositionRepository.findOpen();

    let updated = 0, closed = 0;

    for(const position of open){

        const tracking = evaluatePosition(position);

        if(!tracking) continue;

        tradePositionRepository.updateTracking(position, tracking);

        updated++;

        if(tracking.status !== "OPEN") closed++;

    }

    return { checked: open.length, updated, closed };

}

// =====================================
// 3. PREDICTION TIMELINE - unchanged in concept; now naturally covers
// every decision row (not just position-opening ones), which is
// intentional - "how did price move after THIS decision" is meaningful
// regardless of whether a position was opened for it.
// =====================================

function recordTimelineSnapshots(){

    const predictions = predictionHistoryRepository.findAllLite();

    let recorded = 0;

    for(const p of predictions){

        const existingHorizons = predictionTimelineRepository.findExistingHorizons(p.id);

        for(const h of config.timelineHorizons){

            if(existingHorizons.has(h.label)) continue;

            const targetTimestamp = toSqliteTimestamp(new Date(parseSqliteTimestamp(p.prediction_time) + h.seconds * 1000));

            if(Date.now() < parseSqliteTimestamp(targetTimestamp)) continue;

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

        }

    }

    return { recorded };

}

function runCycle(){

    const t0 = Date.now();
    const createResult = evaluateAndRecordDecisions();
    const updateResult = updateOpenTradePositions();
    const timelineResult = recordTimelineSnapshots();

    return { createResult, updateResult, timelineResult, durationMs: Date.now() - t0 };

}

module.exports = {
    evaluateAndRecordDecisions, updateOpenTradePositions, recordTimelineSnapshots, runCycle,
    computeFailureReason, computeWinReason,
    // Backward-compatible aliases (old names, same behavior) in case
    // anything else in the codebase still imports the pre-redesign names.
    createNewPredictions: evaluateAndRecordDecisions,
    updateOpenPredictions: updateOpenTradePositions
};
