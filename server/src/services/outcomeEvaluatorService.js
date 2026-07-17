// services/outcomeEvaluatorService.js - checks recommendations whose
// 15m/30m/1h/4h/24h horizon has elapsed against real price history
// (token_price_history), and records what actually happened. Never
// invents a price: if nothing was collected yet at/after the horizon
// timestamp, that recommendation is simply left pending and retried
// next run - no interpolation, no estimate.

const validationConfig = require("../config/validationConfig");
const recommendationLogRepository = require("../repositories/recommendationLogRepository");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");

function isWin(action, returnPct){

    const w = validationConfig.winDefinition;

    if(action === "STRONG BUY" || action === "BUY") return returnPct > w.buyMinReturnPct;

    if(action === "HOLD") return returnPct > w.holdMinReturnPct;

    // AVOID (and any unrecognized action, treated conservatively the same way)
    return returnPct <= w.avoidMaxReturnPct;

}

function horizonTargetTimestamp(recordedAt, seconds){

    // recordedAt is SQLite's "YYYY-MM-DD HH:MM:SS" (UTC, no offset).
    const then = new Date(`${String(recordedAt).replace(" ", "T")}Z`).getTime();

    return new Date(then + seconds * 1000).toISOString().slice(0, 19).replace("T", " ");

}

function evaluateHorizon(horizon){

    const due = recommendationLogRepository.findDueForHorizon(horizon.label, horizon.seconds);

    if(!due.length) return { horizon: horizon.label, evaluated: 0, pending: 0 };

    const outcomes = [];

    let stillPending = 0;

    for(const rec of due){

        if(rec.price_at_recommendation == null || rec.price_at_recommendation === 0){

            stillPending++; // can't compute a % return without a real starting price

            continue;

        }

        const targetTimestamp = horizonTargetTimestamp(rec.recorded_at, horizon.seconds);

        const pricePoint = tokenPriceHistoryRepository.findPriceAtOrAfter(rec.token_address, targetTimestamp);

        if(!pricePoint || pricePoint.price == null){

            stillPending++; // nothing collected yet at/after this horizon - try again next run

            continue;

        }

        const returnPct = ((pricePoint.price - rec.price_at_recommendation) / rec.price_at_recommendation) * 100;

        outcomes.push({

            recommendationId: rec.id,

            horizon: horizon.label,

            priceAtHorizon: pricePoint.price,

            returnPct,

            win: isWin(rec.action, returnPct) ? 1 : 0

        });

    }

    if(outcomes.length) recommendationLogRepository.insertOutcomes(outcomes);

    return { horizon: horizon.label, evaluated: outcomes.length, pending: stillPending };

}

function evaluateDueOutcomes(){

    return validationConfig.horizons.map(evaluateHorizon);

}

module.exports = { evaluateDueOutcomes, isWin };
