// services/intelligence/participant/kol.js - same pattern as
// smartMoney.js (both the volume-significance blend and the
// earliness discount), sourced from gmgn_activity_feed
// (feed_type='kol'). See that file's header for the full reasoning.

const config = require("../../../config/scoringConfig");
const { lookupFactor } = require("../curveHelper");

const MAX_SCORE = config.participant.weights.kol;

const MIN_VOLUME = config.participant.minSignificantVolumeUsd.kol;

function score(activities, change1h){

    if(!activities || !activities.length){

        return {

            score: Math.round(MAX_SCORE * config.participant.neutralFraction),

            max: MAX_SCORE,

            hasData: false,

            reasons: [],

            riskReasons: []

        };

    }

    const buys = activities.filter(a => a.side === "buy");

    const sells = activities.filter(a => a.side === "sell");

    const buyUsd = buys.reduce((sum, a) => sum + Number(a.amount_usd || 0), 0);

    const sellUsd = sells.reduce((sum, a) => sum + Number(a.amount_usd || 0), 0);

    const totalVolume = buyUsd + sellUsd;

    const volumeConfidence = Math.min(1, totalVolume / MIN_VOLUME);

    const reasons = [];

    const riskReasons = [];

    let directionScore;

    const isAccumulating = buyUsd > sellUsd * 1.3;

    const isDistributing = sellUsd > buyUsd * 1.3;

    if(isAccumulating) directionScore = MAX_SCORE;
    else if(isDistributing) directionScore = MAX_SCORE * 0.15;
    else directionScore = MAX_SCORE * 0.5;

    const neutralPoint = MAX_SCORE * 0.5;

    let raw = neutralPoint + (directionScore - neutralPoint) * volumeConfidence;

    if(isAccumulating && totalVolume >= MIN_VOLUME){

        reasons.push(`KOL accumulation detected ($${Math.round(buyUsd).toLocaleString()} bought vs $${Math.round(sellUsd).toLocaleString()} sold recently)`);

    }
    else if(isAccumulating){

        reasons.push(`KOL leaning toward accumulation, but sample is small ($${Math.round(buyUsd).toLocaleString()} bought vs $${Math.round(sellUsd).toLocaleString()} sold - below the $${MIN_VOLUME} significance threshold)`);

    }
    else if(isDistributing){

        riskReasons.push(`KOL distribution detected ($${Math.round(sellUsd).toLocaleString()} sold vs $${Math.round(buyUsd).toLocaleString()} bought recently)`);

    }
    else{

        reasons.push(`KOL activity detected (${activities.length} recent trade(s))`);

    }

    // BUGFIX (engine-quality sprint) - see accumulation.js's identical
    // comment: magnitude, not signed value, or a crashing token was
    // wrongly scored as "early" and kept full participant credit.
    const earlinessFactor = lookupFactor(config.participant.earlinessCurve, Math.abs(change1h ?? 0), "maxChange1h");

    const finalScore = Math.round(raw * earlinessFactor);

    if(earlinessFactor < 0.5 && isAccumulating && totalVolume >= MIN_VOLUME){

        reasons[reasons.length-1] += " - discounted, price has already moved significantly";

    }

    return { score: finalScore, max: MAX_SCORE, hasData: true, reasons, riskReasons };

}

module.exports = { score, MAX_SCORE };
