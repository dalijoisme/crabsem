// services/walletQueryService.js - orchestration for every
// wallet-facing endpoint. No SQL here - only repository calls and
// response shaping (same convention as tokenQueryService.js).

const walletRepository = require("../repositories/walletRepository");
const walletTradePositionRepository = require("../repositories/walletTradePositionRepository");
const walletScoreHistoryRepository = require("../repositories/walletScoreHistoryRepository");
const walletDailySnapshotRepository = require("../repositories/walletDailySnapshotRepository");
const walletSimilarityService = require("./walletSimilarityService");

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

function getProfile(address){

    const wallet = walletRepository.findByAddress(address);

    if(!wallet) return null;

    return {

        wallet,

        recentPositions: walletTradePositionRepository.findByWallet(address, 50),

        scoreHistory: walletScoreHistoryRepository.findByWallet(address, 60),

        dailySnapshots: walletDailySnapshotRepository.findByWallet(address, 30),

        similarWallets: walletSimilarityService.findSimilarWallets(address, 10).wallets

    };

}

function leaderboard({ limit = 50, sortColumn = "score", direction = "DESC", q, from, to } = {}){

    return walletRepository.search({ minTrades: 3, limit, sortColumn, direction: direction === "ASC" ? "ASC" : "DESC", q, from, to });

}

module.exports = { search, countSearch, getProfile, leaderboard };
