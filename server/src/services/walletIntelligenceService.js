// services/walletIntelligenceService.js - turns the real matched
// positions in wallet_trade_positions into per-wallet stats, a score,
// a risk profile, and an auto-label - all computed, never fabricated.
// "Win" is defined by ROI% (price direction), not the dollar
// profit_usd field on a position, because profit_usd there compares
// two independently-sized trade legs (a partial exit looks like a
// "loss" in dollars even when price went up) - see
// walletLedgerService.js's own note on this. ROI% has no such
// distortion.

const db = require("../database/connection");
const config = require("../config/walletIntelligenceConfig");
const walletRepository = require("../repositories/walletRepository");
const walletScoreHistoryRepository = require("../repositories/walletScoreHistoryRepository");
const walletDailySnapshotRepository = require("../repositories/walletDailySnapshotRepository");

function mean(nums){ return nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : null; }

function median(nums){

    if(!nums.length) return null;

    const sorted = [...nums].sort((a,b)=>a-b);

    const mid = Math.floor(sorted.length/2);

    return sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;

}

function bandFor(marketCap){

    if(marketCap == null) return null;

    const band = config.marketCapBands.find(b => marketCap <= b.max);

    return band ? band.label : null;

}

function mostFrequent(values){

    const counts = new Map();

    values.forEach(v => { if(v != null) counts.set(v, (counts.get(v)||0)+1); });

    let best = null, bestCount = 0;

    for(const [v,c] of counts){ if(c > bestCount){ best = v; bestCount = c; } }

    return best;

}

function computeScore(winRate, avgRoiPct, closedCount){

    const c = config.score;

    const winRatePoints = (winRate ?? 0) * c.winRateWeight;

    const clampedRoi = Math.min(c.roiClampMaxPct, Math.max(c.roiClampMinPct, avgRoiPct ?? 0));

    const roiPoints = ((clampedRoi - c.roiClampMinPct) / (c.roiClampMaxPct - c.roiClampMinPct)) * c.roiWeight;

    const confidencePoints = Math.min(c.confidenceWeight, (closedCount / c.confidenceFullAtTrades) * c.confidenceWeight);

    return Math.round(Math.max(0, Math.min(100, winRatePoints + roiPoints + confidencePoints)));

}

function computeConfidence(closedCount){

    return Math.round(Math.min(95, 15 + closedCount * 4));

}

function computeRiskProfile(winRate, avgRoiPct, closedCount){

    if(closedCount < config.minClosedTradesForRanking) return "Unproven";

    if(winRate != null && winRate >= 0.55 && Math.abs(avgRoiPct ?? 0) < 80) return "Conservative";

    if(winRate != null && winRate < 0.35) return "High-Risk";

    return "Aggressive";

}

function computeLabel(ctx){

    const l = config.labels;

    if(ctx.sourceDevWallet && ctx.closedCount <= l.devWalletMaxTradesToLabelDeveloper) return "Developer";

    if(ctx.sniperShare != null && ctx.sniperShare >= l.sniperMinShareOfTrades && ctx.closedCount >= 3) return "Sniper";

    if(ctx.avgPositionUsd != null && ctx.avgPositionUsd >= l.whaleMinAvgPositionUsd) return "Whale";

    if(ctx.closedCount >= l.minTradesForSmartMoney && ctx.winRate != null && ctx.winRate >= l.smartMoneyMinWinRate) return "Smart Money";

    if(ctx.avgHoldingSeconds != null && ctx.avgHoldingSeconds <= l.scalperMaxHoldingSeconds) return "Scalper";

    if(ctx.avgHoldingSeconds != null && ctx.avgHoldingSeconds <= l.swingMinHoldingSeconds) return "Swing Trader";

    if(ctx.avgHoldingSeconds != null && ctx.avgHoldingSeconds >= l.longHolderMinHoldingSeconds) return "Long Holder";

    if(ctx.sourceKol) return "KOL Trader";

    return ctx.closedCount > 0 ? "Trader" : "Unproven";

}

// One batched query for every wallet's positions + the token's real
// launch_time (for sniper detection) - grouped in JS, not one query
// per wallet (see the N+1 lesson from the previous sprint).

function loadAllPositionsGrouped(){

    const rows = db.prepare(`
        SELECT p.wallet_address, p.token_address, p.status, p.roi_pct, p.profit_usd,
               p.holding_seconds, p.entry_amount_usd, p.entry_market_cap, p.entry_time,
               t.launch_time
        FROM wallet_trade_positions p
        LEFT JOIN gmgn_tokens t ON t.token_address = p.token_address
    `).all();

    const byWallet = new Map();

    for(const row of rows){

        if(!byWallet.has(row.wallet_address)) byWallet.set(row.wallet_address, []);

        byWallet.get(row.wallet_address).push(row);

    }

    return byWallet;

}

function recomputeAllWalletStats(){

    const grouped = loadAllPositionsGrouped();

    const walletAddresses = [...grouped.keys()];

    const walletRows = walletRepository.findManyByAddresses(walletAddresses);

    const statsUpdates = [];

    const historyEntries = [];

    const dailyEntries = [];

    const today = new Date().toISOString().slice(0, 10);

    for(const [walletAddress, positions] of grouped){

        const closed = positions.filter(p => p.status === "closed");

        const closedCount = closed.length;

        const rois = closed.map(p => p.roi_pct).filter(v => v != null);

        const winCount = rois.filter(v => v > 0).length;

        const lossCount = rois.filter(v => v <= 0).length;

        const winRate = rois.length ? winCount / rois.length : null;

        const holdings = closed.map(p => p.holding_seconds).filter(v => v != null);

        const positionSizes = positions.map(p => p.entry_amount_usd).filter(v => v != null);

        const profits = closed.map(p => p.profit_usd).filter(v => v != null);

        const bands = positions.map(p => bandFor(p.entry_market_cap));

        const sniperEligible = positions.filter(p => p.launch_time && p.entry_time);

        const sniperHits = sniperEligible.filter(p => {

            const launchMs = new Date(`${p.launch_time.replace(" ","T")}Z`).getTime();

            const entryMs = new Date(`${p.entry_time.replace(" ","T")}Z`).getTime();

            return (entryMs - launchMs) >= 0 && (entryMs - launchMs) <= config.labels.sniperMaxSecondsAfterLaunch * 1000;

        });

        const sniperShare = sniperEligible.length >= 3 ? sniperHits.length / sniperEligible.length : null;

        const avgRoiPct = mean(rois);

        const avgHoldingSeconds = mean(holdings);

        const avgPositionUsd = mean(positionSizes);

        const existing = walletRows.get(walletAddress);

        const score = computeScore(winRate, avgRoiPct, closedCount);

        const confidence = computeConfidence(closedCount);

        const riskProfile = computeRiskProfile(winRate, avgRoiPct, closedCount);

        const primaryLabel = computeLabel({

            sourceDevWallet: existing?.source_dev_wallet,

            sourceKol: existing?.source_kol,

            closedCount,

            winRate,

            avgHoldingSeconds,

            avgPositionUsd,

            sniperShare

        });

        statsUpdates.push({

            walletAddress,

            totalTrades: positions.length,

            buyCount: positions.length,

            sellCount: closedCount,

            closedPositionCount: closedCount,

            openPositionCount: positions.length - closedCount,

            winCount,

            lossCount,

            winRate,

            avgRoiPct,

            medianRoiPct: median(rois),

            bestRoiPct: rois.length ? Math.max(...rois) : null,

            worstRoiPct: rois.length ? Math.min(...rois) : null,

            avgHoldingSeconds,

            avgPositionUsd,

            realizedProfitUsd: profits.length ? profits.reduce((a,b)=>a+b,0) : null,

            largestWinnerUsd: profits.filter(p=>p>0).length ? Math.max(...profits.filter(p=>p>0)) : null,

            largestLoserUsd: profits.filter(p=>p<0).length ? Math.min(...profits.filter(p=>p<0)) : null,

            favoriteMarketCapBand: mostFrequent(bands),

            score,

            confidence,

            primaryLabel,

            riskProfile

        });

        historyEntries.push({ walletAddress, score, winRate, avgRoiPct, primaryLabel, riskProfile, totalTrades: positions.length });

        dailyEntries.push({

            walletAddress,

            snapshotDate: today,

            tradesCount: positions.length,

            realizedProfitUsd: profits.length ? profits.reduce((a,b)=>a+b,0) : null,

            winRate,

            score

        });

    }

    if(statsUpdates.length) walletRepository.updateManyStats(statsUpdates);

    if(historyEntries.length) walletScoreHistoryRepository.insertMany(historyEntries);

    if(dailyEntries.length) walletDailySnapshotRepository.upsertMany(dailyEntries);

    return { walletsScored: statsUpdates.length };

}

module.exports = { recomputeAllWalletStats };
