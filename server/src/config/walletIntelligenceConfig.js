// config/walletIntelligenceConfig.js - every tunable number the
// wallet scoring/labeling engine uses, kept out of the scoring logic
// itself (same convention as config/scoringConfig.js).

module.exports = {

    score: {

        winRateWeight: 60,   // 0-60 points from win rate
        roiWeight: 30,       // 0-30 points from average ROI, clamped
        roiClampMinPct: -50,
        roiClampMaxPct: 200,
        confidenceWeight: 10, // 0-10 points, scales with sample size
        confidenceFullAtTrades: 20

    },

    // Auto-label thresholds - all computed from real, already-observed
    // behavior (holding time, position size, win rate, launch-timing),
    // never a guess about intent.
    labels: {

        minTradesForSmartMoney: 5,
        smartMoneyMinWinRate: 0.6,

        scalperMaxHoldingSeconds: 5 * 60,
        swingMinHoldingSeconds: 60 * 60,
        longHolderMinHoldingSeconds: 24 * 60 * 60,

        whaleMinAvgPositionUsd: 5000,

        sniperMaxSecondsAfterLaunch: 5 * 60,
        sniperMinShareOfTrades: 0.5,

        devWalletMaxTradesToLabelDeveloper: 3

    },

    marketCapBands: [
        { max: 100000, label: "micro" },
        { max: 1000000, label: "small" },
        { max: 10000000, label: "mid" },
        { max: Infinity, label: "large" }
    ],

    minClosedTradesForRanking: 3,

    // Similarity feature weights - see walletSimilarityService.js.
    similarity: {

        minTradesForProfile: 3,
        maxCandidates: 3000,
        weights: { winRate: 0.35, avgRoiPct: 0.25, avgHoldingSeconds: 0.2, avgPositionUsd: 0.2 }

    }

};
