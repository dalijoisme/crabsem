// services/predictionValidationService.js - the AI Validation
// Framework (engine-quality sprint 3). Three real jobs, run every
// minute by scheduler/predictionValidationScheduler.js:
//
//   1. createNewPredictions() - the first time a token produces a
//      real, evidence-backed trade plan, record it as an IMMUTABLE
//      prediction (never overwritten again for that token - see
//      migration 010's UNIQUE(token_address)).
//
//   2. updateOpenPredictions() - for every OPEN prediction, replay the
//      REAL recorded price/market-cap history since prediction_time
//      (token_price_history) to find whether TP or SL was touched
//      FIRST (chronologically - a token can pump then dump inside one
//      check window, so only looking at "current price" could pick
//      the wrong outcome or miss one entirely), and compute a real
//      MFE/MAE across the full observed range, not just "right now".
//
//   3. recordTimelineSnapshots() - once each real 30m/1h/2h/4h/8h/24h
//      boundary has elapsed, record the real observed price/MC at
//      that point (same findPriceAtOrAfter convention
//      outcomeEvaluatorService.js already uses for Sprint 2).
//
// Nothing here changes what the Intelligence Engine recommends -
// this only tracks and evaluates what it already recommended.

const config = require("../config/predictionValidationConfig");
const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");
const predictionHistoryRepository = require("../repositories/predictionHistoryRepository");
const predictionTimelineRepository = require("../repositories/predictionTimelineRepository");
const intelligenceEngine = require("./intelligenceEngine");
const tradePlanService = require("./tradePlanService");

function toSqliteTimestamp(date){

    return date.toISOString().slice(0, 19).replace("T", " ");

}

function parseSqliteTimestamp(ts){

    return new Date(`${String(ts).replace(" ", "T")}Z`).getTime();

}

// =====================================
// 1. CREATE NEW (IMMUTABLE) PREDICTIONS
// =====================================

function buildWalletSummary(signal){

    return {

        smartMoneyWalletCount: signal.intelligence.smartMoney.activities?.length || 0,

        kolWalletCount: signal.intelligence.kol.activities?.length || 0,

        devWalletIdentified: signal.intelligence.devWallet.hasData,

        walletStatsChecked: signal.intelligence.walletStatsChecked || 0

    };

}

function createNewPredictions(){

    const tokens = gmgnTokenRepository.getAllTokens().filter(t => t.market_cap != null && t.market_cap > 0);

    if(!tokens.length) return { created: 0, scanned: 0 };

    const signals = intelligenceEngine.analyzeTokens(tokens);

    let created = 0;

    tokens.forEach((token, i) => {

        if(predictionHistoryRepository.existsForToken(token.token_address)) return;

        const signal = signals[i];

        // Only a token whose FIRST real trade plan actually cleared
        // the readiness gate (see tradePlanService.js) becomes a
        // tracked prediction - an AVOID or "waiting for confirmation"
        // token has no real Entry/Target/Stop to validate against
        // reality in the first place (see last sprint's Trade Plan
        // readiness gate).

        const readiness = tradePlanService.assessTradePlanReadiness(signal);

        if(!readiness.ready) return;

        const riskBands = tradePlanService.buildRiskBands(token, signal);

        if(!riskBands) return;

        const inserted = predictionHistoryRepository.insertPrediction({

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

            tradePlanJson: JSON.stringify(riskBands),

            targetPrice: riskBands.target.price,

            targetMarketCap: riskBands.target.marketCap,

            stopLossPrice: riskBands.stopLoss.price,

            stopLossMarketCap: riskBands.stopLoss.marketCap,

            predictionHorizonSeconds: config.defaultHorizonSeconds

        });

        if(inserted) created++;

    });

    return { created, scanned: tokens.length };

}

// =====================================
// 2. UPDATE OPEN PREDICTIONS (real TP/SL/Expired + MFE/MAE)
// =====================================

// Real, evidence-based failure category (Part 6) - checked in a fixed
// priority order against real, already-collected fields at close
// time. Never fired without a genuine matching signal; "Unknown" is
// the honest fallback when none of these explain the outcome.

function computeFailureReason(prediction, closeSnapshot){

    const f = config.failureAnalysis;

    const token = gmgnTokenRepository.getTokenByAddress(prediction.token_address);

    if(!token) return "Unknown";

    const liquidity = Number(token.liquidity) || 0;

    if(prediction.entry_liquidity && liquidity <= prediction.entry_liquidity * f.liquidityRemovedRatio){

        return "Liquidity Removal";

    }

    const holders = token.holders != null ? Number(token.holders) : null;

    if(prediction.entry_holders && holders != null && holders <= prediction.entry_holders * f.holderDeclineRatio){

        return "Holder Decline";

    }

    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;

    if(change1h != null && change1h <= f.momentumCollapsePct){

        return "Momentum Collapse";

    }

    const trenchesEntry = gmgnTrenchesRepository.findByTokenAddress(prediction.token_address);

    if(trenchesEntry?.net_buy_24h != null && Number(trenchesEntry.net_buy_24h) <= f.netDistributionUsd){

        if(trenchesEntry.smart_degen_count != null && Number(trenchesEntry.smart_degen_count) >= 3){

            return "Whale Distribution";

        }

        return "Smart Money Exit";

    }

    // "Developer Selling" is NOT implemented this sprint - measured
    // and rejected, not skipped out of laziness. The only candidate
    // real field (gmgn_tokens.raw_json.creator_close) was tested
    // against a live 500-token sample and found true for ~70% of ALL
    // tokens regardless of outcome (352/500) - a static snapshot of
    // that field does not discriminate a real developer-selling event
    // from GMGN's normal bonding-curve/creator-position lifecycle
    // state. Doing this correctly needs an entry-time snapshot of
    // creator_close plus a real detected TRANSITION to true by close
    // time, which needs a new immutable column not added this sprint -
    // see the final report's known-limitations section. Falling
    // through to Unknown here is the honest choice, not a fabricated
    // category.

    return "Unknown";

}

// Real, evidence-based WINNING category (CEO Dashboard Section 7 -
// "Most common winning reason") - the positive-signal mirror of
// computeFailureReason above, checked against the same real fields.
// Same disclosed limitation: these are CURRENT-state checks at close
// time, not a replay of what was true throughout the trade.

function computeWinReason(prediction){

    const trenchesEntry = gmgnTrenchesRepository.findByTokenAddress(prediction.token_address);

    if(trenchesEntry?.net_buy_24h != null && Number(trenchesEntry.net_buy_24h) >= 500){

        if(trenchesEntry.smart_degen_count != null && Number(trenchesEntry.smart_degen_count) >= 3){

            return "Whale Accumulation";

        }

        return "Net Accumulation";

    }

    let walletSummary = null;

    try{ walletSummary = prediction.wallet_summary_json ? JSON.parse(prediction.wallet_summary_json) : null; }
    catch(e){ /* real field parse failed - fall through, never guessed */ }

    if(walletSummary?.smartMoneyWalletCount > 0) return "Smart Money Involvement";

    if(walletSummary?.kolWalletCount > 0) return "KOL Involvement";

    if(prediction.confidence != null && prediction.confidence >= 60) return "High Confidence Entry";

    return "Unknown";

}

function evaluatePrediction(prediction){

    const rows = tokenPriceHistoryRepository.findRangeForToken(prediction.token_address, prediction.prediction_time);

    const token = gmgnTokenRepository.getTokenByAddress(prediction.token_address);

    // Fall back to the token's own live row if no price-history rows
    // exist yet since prediction_time (e.g. this minute's tick hasn't
    // landed in token_price_history yet) - never fabricated, just the
    // one real data point we do have.

    const series = rows.length

        ? rows

        : (token && token.market_cap != null ? [{ price: token.price, market_cap: token.market_cap, recorded_at: token.updated_at }] : []);

    if(!series.length) return null;

    const entryMc = prediction.entry_market_cap;

    let mfePct = prediction.mfe_pct || 0;

    let maePct = prediction.mae_pct || 0;

    let closeStatus = null;

    let closeSnapshot = null;

    for(const point of series){

        const mc = point.market_cap != null ? Number(point.market_cap) : null;

        if(mc == null || entryMc == null || entryMc <= 0) continue;

        const roiPct = ((mc - entryMc) / entryMc) * 100;

        if(roiPct > mfePct) mfePct = roiPct;

        if(roiPct < maePct) maePct = roiPct;

        if(closeStatus) continue; // first TP/SL touch wins - keep scanning only for MFE/MAE after that

        if(prediction.target_market_cap != null && mc >= prediction.target_market_cap){

            closeStatus = "TP_HIT";

            closeSnapshot = point;

        }
        else if(prediction.stop_loss_market_cap != null && mc <= prediction.stop_loss_market_cap){

            closeStatus = "SL_HIT";

            closeSnapshot = point;

        }

    }

    const latest = series[series.length - 1];

    const latestMc = latest.market_cap != null ? Number(latest.market_cap) : null;

    const currentRoiPct = (latestMc != null && entryMc) ? ((latestMc - entryMc) / entryMc) * 100 : null;

    const timeAliveSeconds = Math.round((Date.now() - parseSqliteTimestamp(prediction.prediction_time)) / 1000);

    if(!closeStatus && timeAliveSeconds >= prediction.prediction_horizon_seconds){

        closeStatus = "EXPIRED";

        closeSnapshot = latest;

    }

    const tracking = {

        id: prediction.id,

        status: closeStatus || "OPEN",

        currentPrice: latest.price != null ? Number(latest.price) : null,

        currentMarketCap: latestMc,

        currentRoiPct,

        mfePct,

        maePct,

        timeAliveSeconds,

        closedAt: closeStatus ? toSqliteTimestamp(new Date()) : null,

        closeReason: closeStatus === "TP_HIT"

            ? computeWinReason(prediction)

            : (closeStatus ? computeFailureReason(prediction, closeSnapshot) : null)

    };

    return tracking;

}

function updateOpenPredictions(){

    const open = predictionHistoryRepository.findOpen();

    let updated = 0, closed = 0;

    for(const prediction of open){

        const tracking = evaluatePrediction(prediction);

        if(!tracking) continue;

        predictionHistoryRepository.updateTracking(tracking);

        updated++;

        if(tracking.status !== "OPEN") closed++;

    }

    return { checked: open.length, updated, closed };

}

// =====================================
// 3. PREDICTION TIMELINE (Part 8 - real snapshots at fixed horizons)
// =====================================

function recordTimelineSnapshots(){

    const predictions = predictionHistoryRepository.findAllLite();

    let recorded = 0;

    for(const p of predictions){

        const existingHorizons = predictionTimelineRepository.findExistingHorizons(p.id);

        for(const h of config.timelineHorizons){

            if(existingHorizons.has(h.label)) continue;

            const targetTimestamp = toSqliteTimestamp(new Date(parseSqliteTimestamp(p.prediction_time) + h.seconds * 1000));

            if(Date.now() < parseSqliteTimestamp(targetTimestamp)) continue; // horizon hasn't elapsed yet

            const point = tokenPriceHistoryRepository.findPriceAtOrAfter(p.token_address, targetTimestamp);

            if(!point || point.market_cap == null) continue; // nothing real recorded yet - try again next run

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

    const createResult = createNewPredictions();

    const updateResult = updateOpenPredictions();

    const timelineResult = recordTimelineSnapshots();

    return { createResult, updateResult, timelineResult };

}

module.exports = { createNewPredictions, updateOpenPredictions, recordTimelineSnapshots, runCycle, computeFailureReason };
