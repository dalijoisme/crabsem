// services/intelligence/participant/sniper.js - inverse-risk
// scorer: high sniper-bot concentration is a real warning sign
// (bots that buy instantly at launch and dump on retail, not
// genuine participants). Scores HIGH when sniper presence is LOW,
// consistent with every other module's "higher score = more
// bullish" convention.
//
// sniper_count is a gmgn_trenches column; top70_sniper_hold_rate is
// a real field in the same row's raw_json, parsed defensively.

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.participant.weights.sniperQuality;

function parseHoldRate(trenchesEntry){

    if(!trenchesEntry?.raw_json) return null;

    try{

        const raw = JSON.parse(trenchesEntry.raw_json);

        return raw.top70_sniper_hold_rate != null ? Number(raw.top70_sniper_hold_rate) : null;

    }
    catch(e){

        return null;

    }

}

function score(trenchesEntry){

    if(!trenchesEntry || trenchesEntry.sniper_count == null){

        return {

            score: Math.round(MAX_SCORE * config.participant.neutralFraction),

            max: MAX_SCORE,

            hasData: false,

            reasons: [],

            riskReasons: []

        };

    }

    const sniperCount = Number(trenchesEntry.sniper_count);

    const holdRate = parseHoldRate(trenchesEntry);

    const riskReasons = [];

    const reasons = [];

    let raw = MAX_SCORE;

    if(sniperCount >= 30){ raw = MAX_SCORE * 0.15; riskReasons.push(`High sniper-bot count (${sniperCount})`); }
    else if(sniperCount >= 10) raw = MAX_SCORE * 0.5;
    else if(sniperCount === 0) reasons.push("No sniper-bot activity detected");

    if(holdRate != null && holdRate >= 0.15){

        raw *= 0.6;

        riskReasons.push(`Snipers hold ${(holdRate*100).toFixed(0)}% of top holdings`);

    }

    return { score: Math.round(raw), max: MAX_SCORE, hasData: true, reasons, riskReasons };

}

module.exports = { score, MAX_SCORE };
