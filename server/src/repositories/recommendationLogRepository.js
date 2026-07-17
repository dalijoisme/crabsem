// repositories/recommendationLogRepository.js - the only place that
// reads/writes recommendation_log and recommendation_outcomes. Never
// computes a recommendation itself (that's intelligenceEngine.js) -
// this only records what the engine already said, and later records
// what actually happened.

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO recommendation_log (
        token_address, symbol, action, stage, participant_score,
        market_health, confidence, risk, lifecycle, price_at_recommendation,
        reasons_json, confirmations_json, risk_reasons_json, breakdown_json
    ) VALUES (
        @tokenAddress, @symbol, @action, @stage, @participantScore,
        @marketHealth, @confidence, @risk, @lifecycle, @priceAtRecommendation,
        @reasonsJson, @confirmationsJson, @riskReasonsJson, @breakdownJson
    )
`);

function insertMany(entries){

    const runMany = db.transaction((items) => {

        items.forEach(e => insertStmt.run(e));

    });

    runMany(entries);

    return entries.length;

}

// Recommendations whose `horizon` window has elapsed (recorded_at is
// at least `horizonSeconds` old) and that don't already have an
// outcome recorded for this horizon - i.e. still due for evaluation.

function findDueForHorizon(horizon, horizonSeconds, batchLimit = 500){

    return db.prepare(`
        SELECT rl.*
        FROM recommendation_log rl
        WHERE datetime(rl.recorded_at) <= datetime('now', '-' || ? || ' seconds')
          AND NOT EXISTS (
              SELECT 1 FROM recommendation_outcomes ro
              WHERE ro.recommendation_id = rl.id AND ro.horizon = ?
          )
        ORDER BY rl.recorded_at ASC
        LIMIT ?
    `).all(horizonSeconds, horizon, batchLimit);

}

const insertOutcomeStmt = db.prepare(`
    INSERT INTO recommendation_outcomes (recommendation_id, horizon, price_at_horizon, return_pct, win)
    VALUES (@recommendationId, @horizon, @priceAtHorizon, @returnPct, @win)
    ON CONFLICT(recommendation_id, horizon) DO UPDATE SET
        price_at_horizon = excluded.price_at_horizon,
        return_pct = excluded.return_pct,
        win = excluded.win,
        evaluated_at = CURRENT_TIMESTAMP
`);

function insertOutcomes(outcomes){

    const runMany = db.transaction((items) => {

        items.forEach(o => insertOutcomeStmt.run(o));

    });

    runMany(outcomes);

    return outcomes.length;

}

// Real decision history for one token - what CRAB actually
// recommended, when, and why - the backbone of the AI Trade Plan
// (see services/tradePlanService.js). Never a forecast; every row
// here is something the engine already decided in the past.

function findRecentByToken(tokenAddress, limit = 30){

    return db.prepare(`
        SELECT recorded_at, action, stage, participant_score, market_health,
               confidence, risk, price_at_recommendation, reasons_json
        FROM recommendation_log
        WHERE token_address = ?
        ORDER BY recorded_at DESC
        LIMIT ?
    `).all(tokenAddress, limit);

}

function countLogged(){

    return db.prepare("SELECT COUNT(*) as count FROM recommendation_log").get().count;

}

function countOutcomes(){

    return db.prepare("SELECT COUNT(*) as count FROM recommendation_outcomes").get().count;

}

// Raw joined rows for the metrics service to aggregate in JS - kept
// here (not ad-hoc GROUP BY SQL scattered in the service) so this
// file stays the one place that knows the schema shape.

function findOutcomesForMetrics(horizon){

    return db.prepare(`
        SELECT rl.action, ro.return_pct, ro.win
        FROM recommendation_outcomes ro
        JOIN recommendation_log rl ON rl.id = ro.recommendation_id
        WHERE ro.horizon = ?
    `).all(horizon);

}

module.exports = {
    insertMany,
    findDueForHorizon,
    insertOutcomes,
    countLogged,
    countOutcomes,
    findOutcomesForMetrics,
    findRecentByToken
};
