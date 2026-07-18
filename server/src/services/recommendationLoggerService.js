// services/recommendationLoggerService.js - records what the
// Intelligence Engine actually recommended, once per scheduler tick,
// for every currently-tracked token. This is the only way the
// validation framework (Sprint 2) can later be checked against real
// outcomes - the engine itself never persists a recommendation (see
// intelligenceEngine.js's own doc comment), so without this there
// would be nothing to evaluate.

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const recommendationLogRepository = require("../repositories/recommendationLogRepository");
const intelligenceEngine = require("./intelligenceEngine");

function logRecommendations(){

    const tokens = gmgnTokenRepository.getAllTokens();

    if(!tokens.length) return { logged: 0 };

    const signals = intelligenceEngine.analyzeTokens(tokens);

    const entries = tokens.map((token, i) => {

        const s = signals[i];

        // Real snapshot of the participant wallet composition that
        // fed THIS recommendation - not a new lookup, just persisting
        // counts already gathered by analyzeToken() this same call
        // (see intelligenceEngine.js's `intelligence` block). This is
        // the "Next Foundation" data a future learning system needs
        // to explain why a recommendation was made, not just what it
        // was (see migration 009).

        const walletSummary = {

            smartMoneyWalletCount: s.intelligence.smartMoney.activities?.length || 0,

            kolWalletCount: s.intelligence.kol.activities?.length || 0,

            devWalletIdentified: s.intelligence.devWallet.hasData,

            walletStatsChecked: s.intelligence.walletStatsChecked || 0

        };

        return {

            tokenAddress: token.token_address,

            symbol: token.symbol,

            action: s.action,

            stage: s.stage,

            participantScore: s.participantScore,

            marketHealth: s.marketHealth,

            confidence: s.confidence,

            risk: s.risk,

            lifecycle: s.lifecycle,

            priceAtRecommendation: token.price,

            marketCapAtRecommendation: token.market_cap != null ? Number(token.market_cap) : null,

            walletSummaryJson: JSON.stringify(walletSummary),

            reasonsJson: JSON.stringify(s.reasons),

            confirmationsJson: JSON.stringify(s.confirmations),

            riskReasonsJson: JSON.stringify(s.riskReasons),

            breakdownJson: JSON.stringify(s.breakdown)

        };

    });

    recommendationLogRepository.insertMany(entries);

    return { logged: entries.length };

}

module.exports = { logRecommendations };
