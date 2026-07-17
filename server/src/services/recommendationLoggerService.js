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
