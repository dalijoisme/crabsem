// services/intelligence/participant/smartMoney.js - real recent
// trades from smart-money-tagged wallets for this specific token
// (gmgn_activity_feed, feed_type='smart_money'). The feed only holds
// the most recent ~50 trades system-wide, so an empty result means
// "not in our recent sample", not "verified zero interest".
//
// Two independent real-data discounts apply:
// - Volume significance: a 100%-buy ratio built from $55 across 3
//   trades is nowhere near the same strength of evidence as the same
//   ratio built from $50,000 - the raw direction score is blended
//   toward neutral in proportion to how far short of
//   minSignificantVolumeUsd.smartMoney the sample is. (Found during
//   this sprint's live-data validation - see INTELLIGENCE_ENGINE.md.)
// - Earliness: smart money buying into a token that hasn't moved yet
//   is a genuine early signal; the same buying after a big run is
//   discounted (see config/scoringConfig.js for the philosophy).

const config = require("../../../config/scoringConfig");
const { lookupFactor } = require("../curveHelper");

const MAX_SCORE = config.participant.weights.smartMoney;

const MIN_VOLUME = config.participant.minSignificantVolumeUsd.smartMoney;

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

    // Blend toward the neutral midpoint when volume is thin - a small
    // sample shouldn't swing the score as hard as a large one.

    const neutralPoint = MAX_SCORE * 0.5;

    let raw = neutralPoint + (directionScore - neutralPoint) * volumeConfidence;

    if(isAccumulating && totalVolume >= MIN_VOLUME){

        reasons.push(`Smart money accumulation detected ($${Math.round(buyUsd).toLocaleString()} bought vs $${Math.round(sellUsd).toLocaleString()} sold recently)`);

    }
    else if(isAccumulating){

        reasons.push(`Smart money leaning toward accumulation, but sample is small ($${Math.round(buyUsd).toLocaleString()} bought vs $${Math.round(sellUsd).toLocaleString()} sold - below the $${MIN_VOLUME} significance threshold)`);

    }
    else if(isDistributing){

        riskReasons.push(`Smart money distribution detected ($${Math.round(sellUsd).toLocaleString()} sold vs $${Math.round(buyUsd).toLocaleString()} bought recently)`);

    }
    else{

        reasons.push(`Smart money activity detected (${activities.length} recent trade(s))`);

    }

    const earlinessFactor = lookupFactor(config.participant.earlinessCurve, change1h ?? 0, "maxChange1h");

    const finalScore = Math.round(raw * earlinessFactor);

    if(earlinessFactor < 0.5 && isAccumulating && totalVolume >= MIN_VOLUME){

        reasons[reasons.length-1] += " - discounted, price has already moved significantly";

    }

    return { score: finalScore, max: MAX_SCORE, hasData: true, reasons, riskReasons };

}

module.exports = { score, MAX_SCORE };
