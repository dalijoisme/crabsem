// services/tradePlanService.js - the AI Trade Plan. Replaces a bare
// BUY/HOLD/AVOID label with an explainable, real-history-backed
// sequence: what the engine has actually decided over time for this
// token (from recommendation_log - never invented), the current live
// decision, and a transparent, formula-driven Entry Zone/Target/Stop
// (heuristic guidance derived from real price/confidence/risk/
// participant-score, clearly not a price forecast).

const config = require("../config/tradePlanConfig");
const recommendationLogRepository = require("../repositories/recommendationLogRepository");

// Collapses raw 5-minute-interval log rows into only the moments the
// decision actually CHANGED - a real timeline of decisions, not log
// noise.

function buildDecisionTimeline(tokenAddress){

    const rows = recommendationLogRepository.findRecentByToken(tokenAddress, config.timelineLimit * 6);

    if(!rows.length) return [];

    // rows are DESC (newest first) - walk oldest-to-newest to detect
    // real transitions, then present newest-first.

    const chronological = [...rows].reverse();

    const events = [];

    let lastAction = null;

    for(const row of chronological){

        if(row.action !== lastAction){

            events.push({

                at: row.recorded_at,

                action: row.action,

                stage: row.stage,

                participantScore: row.participant_score,

                confidence: row.confidence,

                risk: row.risk,

                priceAtDecision: row.price_at_recommendation,

                topReason: safeFirstReason(row.reasons_json)

            });

            lastAction = row.action;

        }

    }

    return events.reverse().slice(0, config.timelineLimit);

}

function safeFirstReason(reasonsJson){

    try{

        const reasons = JSON.parse(reasonsJson || "[]");

        return reasons[0] || null;

    }
    catch(e){ return null; }

}

// Transparent, formula-driven guidance - not a forecast. Every input
// is a real number the engine already computed for this token right
// now; the OUTPUT is a documented heuristic band, framed as such.

function buildRiskBands(currentPrice, signal, token){

    if(currentPrice == null || currentPrice <= 0) return null;

    const momentum = Math.abs(Number(token.price_change_1h) || 0);

    const bandPct = Math.min(

        config.entryZone.maxBandPct,

        Math.max(config.entryZone.minBandPct, momentum * config.entryZone.momentumScaleFactor)

    );

    const entryLow = currentPrice * (1 - bandPct / 100);

    const entryHigh = currentPrice * (1 + bandPct / 100);

    const targetPct = (signal.participantScore / 100) * config.target.maxTargetPct;

    const target = currentPrice * (1 + targetPct / 100);

    let stopPct = signal.risk === "HIGH" ? config.stopLoss.highRiskStopPct : config.stopLoss.baseStopPct;

    if(signal.confidence < config.stopLoss.lowConfidenceThreshold) stopPct += config.stopLoss.lowConfidenceWidenPct;

    const stopLoss = currentPrice * (1 - stopPct / 100);

    return {

        entryZone: { low: entryLow, high: entryHigh, bandPct },

        target: { price: target, expectedMovePct: targetPct },

        stopLoss: { price: stopLoss, distancePct: stopPct },

        disclaimer: "Heuristic guidance derived from this token's own current price, momentum, confidence and risk - not a price prediction or a guarantee."

    };

}

function getTradePlan(token, signal){

    const timeline = buildDecisionTimeline(token.token_address);

    const riskBands = buildRiskBands(token.price, signal, token);

    return {

        timeline,

        current: {

            action: signal.action,

            stage: signal.stage,

            confidence: signal.confidence,

            risk: signal.risk,

            lifecycle: signal.lifecycle,

            asOf: signal.computedAt

        },

        riskBands

    };

}

module.exports = { getTradePlan, buildDecisionTimeline, buildRiskBands };
