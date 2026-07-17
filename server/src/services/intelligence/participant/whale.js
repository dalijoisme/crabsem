// services/intelligence/participant/whale.js - concentration of
// GMGN-identified smart/degen wallets among this token's
// participants (real field: gmgn_trenches.smart_degen_count). This
// is a composition signal (WHO is here), not a timing signal, so it
// is NOT scaled by the earliness curve - a token with real smart
// wallets present is worth noting regardless of recent price action.
// Only has data when the token appears in gmgn_trenches.

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.participant.weights.whale;

function score(trenchesEntry){

    if(!trenchesEntry || trenchesEntry.smart_degen_count == null){

        return {

            score: Math.round(MAX_SCORE * config.participant.neutralFraction),

            max: MAX_SCORE,

            hasData: false,

            reasons: [],

            riskReasons: []

        };

    }

    const count = Number(trenchesEntry.smart_degen_count);

    const reasons = [];

    let raw;

    if(count >= 10){ raw = MAX_SCORE; reasons.push(`${count} smart/degen wallets present`); }
    else if(count >= 3){ raw = MAX_SCORE * 0.75; reasons.push(`${count} smart/degen wallets present`); }
    else if(count >= 1) raw = MAX_SCORE * 0.5;
    else raw = MAX_SCORE * 0.25;

    return { score: Math.round(raw), max: MAX_SCORE, hasData: true, reasons, riskReasons: [] };

}

module.exports = { score, MAX_SCORE };
