// services/adminService.js - business logic behind the Admin Panel
// (/admin). Every number here is read from data the rest of the
// system already collects/computes - this service adds no new data
// source of its own beyond a couple of small aggregation queries
// (wallet label counts, DB file size) that nothing else needed until now.

const fs = require("fs");
const path = require("path");

const config = require("../config/env");
const scoringConfig = require("../config/scoringConfig");
const tradePlanConfig = require("../config/tradePlanConfig");
const validationConfig = require("../config/validationConfig");

const db = require("../database/connection");
const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const walletRepository = require("../repositories/walletRepository");
const gmgnOndemandCacheRepository = require("../repositories/gmgnOndemandCacheRepository");

const healthService = require("./health");
const validationMetricsService = require("./validationMetricsService");
const predictionMetricsService = require("./predictionMetricsService");
const intelligenceEngine = require("./intelligenceEngine");
const tradePlanService = require("./tradePlanService");
const productionEngineResolver = require("./productionEngineResolver");
const dexscreenerClient = require("../collectors/dexscreener/dexscreenerClient");
const dexscreenerTransformer = require("./dexscreenerTransformer");

const gmgnScheduler = require("../scheduler/gmgnTrendingScheduler");

const DB_FILE_PATH = path.resolve(__dirname, "../../", config.DB_PATH);

// =====================================
// SYSTEM
// =====================================

function getSystem(){

    const health = healthService.checkHealth();

    let dbSizeBytes = null;

    try{ dbSizeBytes = fs.statSync(DB_FILE_PATH).size; }
    catch(e){ /* file not found yet on a brand-new install - left null, never guessed */ }

    const latestMigration = db.prepare(
        "SELECT filename, applied_at FROM schema_migrations ORDER BY id DESC LIMIT 1"
    ).get();

    const nextScanEtaSeconds = health.scheduler.lastRunAt
        ? Math.max(0, Math.round((gmgnScheduler.INTERVAL_MS / 1000) - health.scheduler.secondsSinceLastRun))
        : null;

    return {

        engineStatus: health.status,

        database: {

            connected: health.database === "connected",

            sizeBytes: dbSizeBytes,

            path: config.DB_PATH,

            tokenCount: health.tokenCount

        },

        migration: {

            appliedCount: health.migrations,

            latestFile: latestMigration?.filename ?? null,

            latestAppliedAt: latestMigration?.applied_at ?? null

        },

        scheduler: {

            gmgn: {

                intervalSeconds: gmgnScheduler.INTERVAL_MS / 1000,

                lastRunAt: health.scheduler.lastRunAt,

                secondsSinceLastRun: health.scheduler.secondsSinceLastRun,

                nextRunEtaSeconds: nextScanEtaSeconds,

                status: health.scheduler.status

            },

            validation: { intervalSeconds: validationConfig.intervalMs / 1000 },

            wallet: { intervalSeconds: 5 * 60 }

        },

        uptimeSeconds: health.uptime

    };

}

// =====================================
// WALLET
// =====================================

function getWalletsSummary(){

    return {

        totalWallets: walletRepository.countAll(),

        byLabel: walletRepository.countsByLabel()

    };

}

// =====================================
// TOKEN ACTIONS
// =====================================

// "Refresh token" - pulls a real, fresh market snapshot right now
// from DexScreener (the same source Global Search uses) and upserts
// it - never fabricated, and never touches wallet/history tables.

async function refreshToken(address){

    const pairs = await dexscreenerClient.getPairsByTokenAddress(address);

    const best = pairs

        .filter(p => p.chainId === "solana" && p.baseToken?.address === address)

        .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];

    if(!best) return { refreshed: false, reason: "DexScreener has no real pair data for this address" };

    const row = dexscreenerTransformer.transformPair(best);

    gmgnTokenRepository.upsertToken(row);

    return { refreshed: true, symbol: row.symbol, marketCap: row.marketCap, price: row.price };

}

// "Analyze Again" - clears any on-demand facts cached for this
// address (security/top holders/pool info - see
// gmgnOndemandService.js) so the next analysis re-derives them from a
// live GMGN call instead of a possibly-stale cache, then returns a
// freshly computed signal + trade plan.

function reanalyzeToken(address){

    const token = gmgnTokenRepository.getTokenByAddress(address);

    if(!token) return null;

    gmgnOndemandCacheRepository.deleteForAddress(address);

    const signal = intelligenceEngine.analyzeToken(token);

    return { token: { ...token, signal }, tradePlan: tradePlanService.getTradePlan(token, signal) };

}

function deleteTokenCache(address){

    return { deleted: gmgnOndemandCacheRepository.deleteForAddress(address) };

}

// =====================================
// ENGINE (readonly - no edit capability this sprint)
// =====================================

function getEngineConfig(){

    const activeVersion = productionEngineResolver.getActiveVersion();
    const activeMeta = productionEngineResolver.REGISTRY[activeVersion];

    return {

        productionVersion: {
            active: activeVersion,
            status: activeMeta.status,
            engineName: activeMeta.engineShortName,
            exitStrategy: activeMeta.exitStrategyShortName,
            promotedAt: activeMeta.promotedAt
        },

        actionTiers: scoringConfig.actionTiers,

        safetyVeto: scoringConfig.safetyVeto,

        confidence: scoringConfig.confidence,

        risk: scoringConfig.risk,

        participantWeights: scoringConfig.participant.weights,

        marketWeights: scoringConfig.market.weights,

        structuralValidation: scoringConfig.structuralValidation,

        freshness: scoringConfig.freshness,

        tradePlan: {

            entryZone: tradePlanConfig.entryZone,

            target: tradePlanConfig.target,

            stopLoss: tradePlanConfig.stopLoss,

            readiness: tradePlanConfig.readiness

        }

    };

}

// =====================================
// PREDICTION
// =====================================

function getPredictionSummary(){

    return validationMetricsService.getValidationSummary();

}

// =====================================
// DASHBOARD (the login-page landing cards) - pure composition of
// already-existing, already-tested read functions above; no new
// prediction/validation logic is written here, only displayed.
// =====================================

// Product Refinement Sprint, Part 1/2/4 - this used to expose one
// ambiguous `predictionCount` (secretly = getSummary()'s ALL-TIER
// total) alongside a `validationSummary` object that LOOKED like a
// different concept but was the exact same query - the real source of
// the "Prediction Count 2021 vs Prediction Validation 804" confusion
// (both numbers always came from prediction_history via getSummary(),
// just at different date-filter windows). Now split into two
// genuinely distinct, clearly-named concepts:
//   - totalPredictionsGenerated/validatedPredictions/pendingValidation:
//     ALL recommendation tiers, ALL time - "how much has the engine
//     done, and how much of that is finished being checked".
//   - tradingPerformance: STRONG BUY/BUY ONLY (getSummary() is now
//     always trading-tier-scoped - see its own doc comment) - "how did
//     the trades this engine actually took perform".
// holdAvoidEvaluation is the real, separate answer for the two tiers
// that never open a position at all.

function getDashboard(){

    const system = getSystem();

    const predictionCounts = predictionMetricsService.getPredictionCounts();

    const tradingPerformance = predictionMetricsService.getSummary();

    const strongBuySummary = predictionMetricsService.getStrongBuySummary();

    const holdAvoidEvaluation = predictionMetricsService.getHoldAvoidEvaluation();

    return {

        engineStatus: system.engineStatus,

        scheduler: system.scheduler,

        database: system.database,

        totalPredictionsGenerated: predictionCounts.totalPredictionsGenerated,

        validatedPredictions: predictionCounts.validatedPredictions,

        pendingValidation: predictionCounts.pendingValidation,

        tradingPerformance,

        strongBuyCount: strongBuySummary.predictionCount,

        holdAvoidEvaluation

    };

}

module.exports = {

    getSystem,

    getWalletsSummary,

    refreshToken,

    reanalyzeToken,

    deleteTokenCache,

    getEngineConfig,

    getPredictionSummary,

    getDashboard

};
