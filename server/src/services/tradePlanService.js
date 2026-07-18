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
//
// Market Cap is the primary unit (fix: this used to be Price-based,
// which is the wrong frame for meme coins - two tokens at the same
// price can have wildly different supply/valuation). Price is still
// computed and returned as secondary info, derived from the same
// price/marketCap ratio the token already has right now - not a
// second independent estimate.

function buildRiskBands(token, signal){

    const currentMc = Number(token.market_cap) || null;

    const currentPrice = Number(token.price) || null;

    if(currentMc == null || currentMc <= 0) return null;

    // price-per-unit-of-marketcap - lets every MC band also report a
    // real equivalent price without a second calculation basis.
    const priceRatio = (currentPrice != null && currentPrice > 0) ? currentPrice / currentMc : null;

    const toPrice = mc => priceRatio != null ? mc * priceRatio : null;

    const momentum = Math.abs(Number(token.price_change_1h) || 0);

    const bandPct = Math.min(

        config.entryZone.maxBandPct,

        Math.max(config.entryZone.minBandPct, momentum * config.entryZone.momentumScaleFactor)

    );

    const entryLowMc = currentMc * (1 - bandPct / 100);

    const entryHighMc = currentMc * (1 + bandPct / 100);

    const targetPct = (signal.participantScore / 100) * config.target.maxTargetPct;

    const targetMc = currentMc * (1 + targetPct / 100);

    let stopPct = signal.risk === "HIGH" ? config.stopLoss.highRiskStopPct : config.stopLoss.baseStopPct;

    if(signal.confidence < config.stopLoss.lowConfidenceThreshold) stopPct += config.stopLoss.lowConfidenceWidenPct;

    const stopMc = currentMc * (1 - stopPct / 100);

    return {

        entryZone: {

            lowMc: entryLowMc, highMc: entryHighMc,
            lowPrice: toPrice(entryLowMc), highPrice: toPrice(entryHighMc),
            bandPct

        },

        target: { marketCap: targetMc, price: toPrice(targetMc), expectedMovePct: targetPct },

        stopLoss: { marketCap: stopMc, price: toPrice(stopMc), distancePct: stopPct },

        disclaimer: "Heuristic guidance derived from this token's own current market cap, momentum, confidence and risk - not a price prediction or a guarantee."

    };

}

function nowAsSqliteTimestamp(){

    return new Date().toISOString().slice(0, 19).replace("T", " ");

}

function getTradePlan(token, signal){

    const historyTimeline = buildDecisionTimeline(token.token_address);

    // Bug fix: the historical timeline only reflects what the 5-
    // minute recommendationLoggerService batch has already written -
    // and when an action hasn't changed recently, buildDecisionTimeline
    // collapses repeats down to the single row from whenever it FIRST
    // became that action, which can read as hours old even though the
    // recommendation is still current right now. The live signal
    // (computed fresh for this exact request) is always added as the
    // newest timeline entry, stamped with the real current time, so
    // opening the app always shows an up-to-date decision on top -
    // never a stale one waiting on the next batch tick.

    const liveEntry = {

        at: nowAsSqliteTimestamp(),

        action: signal.action,

        stage: signal.stage,

        participantScore: signal.participantScore,

        confidence: signal.confidence,

        risk: signal.risk,

        priceAtDecision: token.price,

        topReason: signal.reasons?.[0] || null,

        isLive: true

    };

    const timeline = [liveEntry, ...historyTimeline];

    const riskBands = buildRiskBands(token, signal);

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
