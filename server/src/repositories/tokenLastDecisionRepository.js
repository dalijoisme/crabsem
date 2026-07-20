// repositories/tokenLastDecisionRepository.js - O(1) "what did we last
// decide for this token" lookup (see migration 017's token_last_decision
// table). Exists purely so the trigger-rule engine
// (predictionValidationService.js) never has to scan/aggregate the
// decision log (prediction_history) - which grows much faster under
// this redesign - to find its comparison point.

const db = require("../database/connection");

const findByTokenStmt = db.prepare("SELECT * FROM token_last_decision WHERE token_address = ?");

function findByToken(tokenAddress){
    return findByTokenStmt.get(tokenAddress);
}

const upsertStmt = db.prepare(`
    INSERT INTO token_last_decision (
        token_address, last_prediction_id, last_recommendation, last_confidence,
        last_participant_score, last_market_health, last_liquidity, last_market_cap, last_volume_1h,
        last_smart_money_score, last_whale_score, last_decision_at
    ) VALUES (
        @tokenAddress, @lastPredictionId, @lastRecommendation, @lastConfidence,
        @lastParticipantScore, @lastMarketHealth, @lastLiquidity, @lastMarketCap, @lastVolume1h,
        @lastSmartMoneyScore, @lastWhaleScore, CURRENT_TIMESTAMP
    )
    ON CONFLICT(token_address) DO UPDATE SET
        last_prediction_id = excluded.last_prediction_id,
        last_recommendation = excluded.last_recommendation,
        last_confidence = excluded.last_confidence,
        last_participant_score = excluded.last_participant_score,
        last_market_health = excluded.last_market_health,
        last_liquidity = excluded.last_liquidity,
        last_market_cap = excluded.last_market_cap,
        last_volume_1h = excluded.last_volume_1h,
        last_smart_money_score = excluded.last_smart_money_score,
        last_whale_score = excluded.last_whale_score,
        last_decision_at = excluded.last_decision_at
`);

function upsert(row){
    upsertStmt.run(row);
}

module.exports = { findByToken, upsert };
