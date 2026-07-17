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

function leaderboard({ limit = 50, sortColumn = "score" } = {}){

    return walletRepository.search({ minTrades: 3, limit, sortColumn, direction: "DESC" });

}

module.exports = { search, getProfile, leaderboard };
