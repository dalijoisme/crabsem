// services/walletSimilarityService.js - "wallets similar to this one"
// computed on demand from real, already-scored behavioral features
// (win rate, avg ROI, avg holding time, avg position size) - a
// nearest-neighbor distance over real numbers, not a trained ML
// model and not fabricated. Computed at query time (not a stored
// pairwise table) since precomputing all pairs would be O(n^2) and
// go stale the moment any wallet's stats update.

const walletRepository = require("../repositories/walletRepository");
const config = require("../config/walletIntelligenceConfig");

function normalize(values){

    const nums = values.filter(v => v != null);

    if(!nums.length) return { min: 0, max: 1 };

    return { min: Math.min(...nums), max: Math.max(...nums) };

}

function scaleTo01(value, range){

    if(value == null) return 0.5; // neutral, not a guess about direction

    if(range.max === range.min) return 0.5;

    return (value - range.min) / (range.max - range.min);

}

function findSimilarWallets(targetAddress, limit = 20){

    const pool = walletRepository.findFeatureVectors(config.similarity.minTradesForProfile, config.similarity.maxCandidates);

    const target = pool.find(w => w.wallet_address === targetAddress);

    if(!target) return { hasProfile: false, wallets: [] };

    const winRateRange = normalize(pool.map(w => w.win_rate));

    const roiRange = normalize(pool.map(w => w.avg_roi_pct));

    const holdRange = normalize(pool.map(w => w.avg_holding_seconds));

    const posRange = normalize(pool.map(w => w.avg_position_usd));

    const vector = w => ([

        scaleTo01(w.win_rate, winRateRange) * config.similarity.weights.winRate,

        scaleTo01(w.avg_roi_pct, roiRange) * config.similarity.weights.avgRoiPct,

        scaleTo01(w.avg_holding_seconds, holdRange) * config.similarity.weights.avgHoldingSeconds,

        scaleTo01(w.avg_position_usd, posRange) * config.similarity.weights.avgPositionUsd

    ]);

    const targetVector = vector(target);

    const scored = pool

        .filter(w => w.wallet_address !== targetAddress)

        .map(w => {

            const v = vector(w);

            const distance = Math.sqrt(v.reduce((sum, x, i) => sum + (x - targetVector[i])**2, 0));

            return { walletAddress: w.wallet_address, primaryLabel: w.primary_label, similarity: Math.max(0, 1 - distance) };

        })

        .sort((a,b) => b.similarity - a.similarity)

        .slice(0, limit);

    return { hasProfile: true, wallets: scored };

}

module.exports = { findSimilarWallets };
