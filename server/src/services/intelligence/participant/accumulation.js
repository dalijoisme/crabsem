// services/intelligence/participant/accumulation.js - direct
// net-flow accumulation/distribution signal, from the real
// gmgn_trenches.net_buy_24h field (buys_24h minus sells_24h in USD,
// as returned by GMGN itself - not derived or estimated by us).
// Only has data when this token appears in gmgn_trenches.
//
// Same volume-significance and earliness discounts as smartMoney.js/
// kol.js - a small net_buy_24h shouldn't score identically to a
// large one just because the sign is the same, and real net buying
// on a token that hasn't moved yet is worth more than the same
// buying after a big run.

const config = require("../../../config/scoringConfig");
const { lookupFactor } = require("../curveHelper");

const MAX_SCORE = config.participant.weights.accumulation;

const MIN_VOLUME = config.participant.minSignificantVolumeUsd.accumulation;

function score(trenchesEntry, change1h){

    if(!trenchesEntry || trenchesEntry.net_buy_24h == null){

        return {

            score: Math.round(MAX_SCORE * config.participant.neutralFraction),

            max: MAX_SCORE,

            hasData: false,

            reasons: [],

            riskReasons: []

        };

    }

    const netBuy = Number(trenchesEntry.net_buy_24h);

    const buys = Number(trenchesEntry.buys_24h || 0);

    const sells = Number(trenchesEntry.sells_24h || 0);

    const totalVolume = buys + sells; // trade count, not USD - used only as a data-presence signal here since GMGN doesn't give per-trade USD for trenches

    const volumeUsd = Math.abs(netBuy);

    const volumeConfidence = Math.min(1, volumeUsd / MIN_VOLUME);

    const reasons = [];

    const riskReasons = [];

    let directionScore = MAX_SCORE * 0.4;

    const dominance = totalVolume > 0 ? buys / Math.max(1, totalVolume) : 0.5;

    if(netBuy > 0 && buys > 0){

        if(dominance >= 0.65) directionScore = MAX_SCORE;
        else if(dominance >= 0.55) directionScore = MAX_SCORE * 0.7;
        else directionScore = MAX_SCORE * 0.45;

    }
    else if(netBuy < 0){

        directionScore = MAX_SCORE * 0.1;

    }

    const neutralPoint = MAX_SCORE * 0.4;

    let raw = neutralPoint + (directionScore - neutralPoint) * volumeConfidence;

    if(netBuy > 0 && volumeUsd >= MIN_VOLUME){

        reasons.push(`Net accumulation detected ($${Math.round(netBuy).toLocaleString()} net buys, 24h)`);

    }
    else if(netBuy > 0){

        reasons.push(`Slight net accumulation ($${Math.round(netBuy).toLocaleString()} net buys, 24h - below the $${MIN_VOLUME} significance threshold)`);

    }
    else if(netBuy < 0 && volumeUsd >= MIN_VOLUME){

        riskReasons.push(`Net distribution detected ($${Math.round(volumeUsd).toLocaleString()} net sells, 24h)`);

    }

    const earlinessFactor = lookupFactor(config.participant.earlinessCurve, change1h ?? 0, "maxChange1h");

    const finalScore = Math.round(raw * earlinessFactor);

    if(earlinessFactor < 0.5 && netBuy > 0 && volumeUsd >= MIN_VOLUME){

        reasons[reasons.length-1] += " - discounted, price has already moved significantly";

    }

    return { score: finalScore, max: MAX_SCORE, hasData: true, reasons, riskReasons };

}

module.exports = { score, MAX_SCORE };
