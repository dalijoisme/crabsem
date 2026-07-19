// services/walletQueryService.js - orchestration for every
// wallet-facing endpoint. No SQL here - only repository calls and
// response shaping (same convention as tokenQueryService.js).

const walletRepository = require("../repositories/walletRepository");
const walletTradePositionRepository = require("../repositories/walletTradePositionRepository");
const walletScoreHistoryRepository = require("../repositories/walletScoreHistoryRepository");
const walletDailySnapshotRepository = require("../repositories/walletDailySnapshotRepository");
const walletSimilarityService = require("./walletSimilarityService");
const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");

function search(params){

    const wallets = walletRepository.search(params);

    return { wallets, count: wallets.length };

}

// Real total count matching the same filter (Admin V3.1, Wallet
// Performance pagination) - separate from search()'s page-sized
// result so the frontend can compute total pages without ever
// fetching more rows than the current page needs.

function countSearch(params){

    return walletRepository.countSearch(params);

}

// Real "current value" for a still-open position (Product Improvement
// Sprint, Part 4 - "Current Holdings"): wallet_trade_positions carries
// no live price on open rows (see that repository's doc comment), so
// this joins each open position's token_address against gmgn_tokens'
// own last-scanned price/market_cap (the same ~30s-cadence "current"
// data every token card elsewhere in this app already uses) - a real,
// last-known value, not a live quote, and disclosed as such below.

function withCurrentValue(position){

    const token = gmgnTokenRepository.getTokenByAddress(position.token_address);

    if(!token || token.price == null || position.entry_price == null){

        return { ...position, currentPrice: null, currentValueUsd: null, unrealizedRoiPct: null, priceSource: null };

    }

    const unrealizedRoiPct = ((token.price - position.entry_price) / position.entry_price) * 100;

    const currentValueUsd = position.entry_amount_usd != null ? position.entry_amount_usd * (1 + unrealizedRoiPct / 100) : null;

    return {

        ...position,

        currentPrice: token.price,

        currentValueUsd,

        unrealizedRoiPct,

        priceSource: `Last scanned ${token.last_seen || token.updated_at || "recently"} (not a live quote)`

    };

}

function getProfile(address){

    const wallet = walletRepository.findByAddress(address);

    if(!wallet) return null;

    const openPositions = walletTradePositionRepository.findOpenByWallet(address, 50).map(withCurrentValue);

    return {

        wallet,

        recentPositions: walletTradePositionRepository.findByWallet(address, 50),

        openPositions,

        bestTrade: walletTradePositionRepository.findBestTrade(address) || null,

        worstTrade: walletTradePositionRepository.findWorstTrade(address) || null,

        scoreHistory: walletScoreHistoryRepository.findByWallet(address, 60),

        dailySnapshots: walletDailySnapshotRepository.findByWallet(address, 30),

        similarWallets: walletSimilarityService.findSimilarWallets(address, 10).wallets,

        // Honest disclosure (Part 4's "Prediction History" ask) - this
        // schema has no wallet_address column on prediction_history, so
        // there is no real per-wallet prediction linkage to show (same
        // established limitation as the Wallet Performance table's
        // Strong BUY/BUY/HOLD/AVOID/Expired columns).
        predictionHistory: {

            available: false,

            reason: "prediction_history has no wallet-address link in this schema, so individual predictions can't be tied to a specific wallet - only this wallet's own real trading outcomes (above) are real."

        }

    };

}

function leaderboard({ limit = 50, sortColumn = "score", direction = "DESC", q, from, to } = {}){

    return walletRepository.search({ minTrades: 3, limit, sortColumn, direction: direction === "ASC" ? "ASC" : "DESC", q, from, to });

}

module.exports = { search, countSearch, getProfile, leaderboard };
