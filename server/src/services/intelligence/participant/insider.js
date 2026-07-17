// services/intelligence/participant/insider.js - inverse-risk
// scorer: a high "suspected insider" hold rate is a real red flag
// (wallets connected to the launch holding a large share, a common
// precursor to coordinated dumps). Real field
// (suspected_insider_hold_rate) lives in gmgn_trenches' raw_json,
// not promoted to a column - parsed defensively.

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.participant.weights.insiderQuality;

function parseInsiderRate(trenchesEntry){

    if(!trenchesEntry?.raw_json) return null;

    try{

        const raw = JSON.parse(trenchesEntry.raw_json);

        return raw.suspected_insider_hold_rate != null ? Number(raw.suspected_insider_hold_rate) : null;

    }
    catch(e){

        return null;

    }

}

function score(trenchesEntry){

    const rate = trenchesEntry ? parseInsiderRate(trenchesEntry) : null;

    if(rate == null){

        return {

            score: Math.round(MAX_SCORE * config.participant.neutralFraction),

            max: MAX_SCORE,

            hasData: false,

            reasons: [],

            riskReasons: []

        };

    }

    const reasons = [];

    const riskReasons = [];

    let raw;

    if(rate >= 0.2){ raw = MAX_SCORE * 0.1; riskReasons.push(`High suspected-insider hold rate (${(rate*100).toFixed(0)}%)`); }
    else if(rate >= 0.05) raw = MAX_SCORE * 0.5;
    else{ raw = MAX_SCORE; reasons.push("Low suspected-insider hold rate"); }

    return { score: Math.round(raw), max: MAX_SCORE, hasData: true, reasons, riskReasons };

}

module.exports = { score, MAX_SCORE };
