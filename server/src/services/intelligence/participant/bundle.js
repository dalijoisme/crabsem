// services/intelligence/participant/bundle.js - inverse-risk
// scorer: a high "bundled" trade rate (coordinated wallets buying
// together, often the same operator behind multiple wallets) is a
// real manipulation/fake-volume warning sign. Real fields
// (bundler_mhr, bundler_trader_amount_rate) live in gmgn_trenches'
// raw_json, not promoted to columns - parsed defensively.

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.participant.weights.bundleQuality;

function parseBundleFields(trenchesEntry){

    if(!trenchesEntry?.raw_json) return null;

    try{

        const raw = JSON.parse(trenchesEntry.raw_json);

        return {

            bundlerMhr: raw.bundler_mhr != null ? Number(raw.bundler_mhr) : null,

            bundlerTraderAmountRate: raw.bundler_trader_amount_rate != null ? Number(raw.bundler_trader_amount_rate) : null

        };

    }
    catch(e){

        return null;

    }

}

function score(trenchesEntry){

    const fields = trenchesEntry ? parseBundleFields(trenchesEntry) : null;

    if(!fields || (fields.bundlerMhr == null && fields.bundlerTraderAmountRate == null)){

        return {

            score: Math.round(MAX_SCORE * config.participant.neutralFraction),

            max: MAX_SCORE,

            hasData: false,

            reasons: [],

            riskReasons: []

        };

    }

    const rate = fields.bundlerTraderAmountRate ?? fields.bundlerMhr ?? 0;

    const reasons = [];

    const riskReasons = [];

    let raw;

    if(rate >= 0.3){ raw = MAX_SCORE * 0.1; riskReasons.push(`High bundled/coordinated trading rate (${(rate*100).toFixed(0)}%)`); }
    else if(rate >= 0.1) raw = MAX_SCORE * 0.5;
    else{ raw = MAX_SCORE; reasons.push("Low bundled/coordinated trading rate"); }

    return { score: Math.round(raw), max: MAX_SCORE, hasData: true, reasons, riskReasons };

}

module.exports = { score, MAX_SCORE };
