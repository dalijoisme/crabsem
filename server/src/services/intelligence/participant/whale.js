// services/intelligence/participant/whale.js - concentration of
// GMGN-identified smart/degen wallets among this token's
// participants (real field: gmgn_trenches.smart_degen_count). This
// is a composition signal (WHO is here), not a timing signal, so it
// is NOT scaled by the earliness curve - a token with real smart
// wallets present is worth noting regardless of recent price action.
// Only has data when the token appears in gmgn_trenches.
//
// Direction (engine-quality sprint): presence alone ("N smart/degen
// wallets here") was previously scored as purely positive regardless
// of whether those sophisticated wallets are actually buying or
// selling right now - a real gap, since a token with 15 smart/degen
// wallets net DUMPING is a worse sign than one with none. net_buy_24h
// is the same real gmgn_trenches field accumulation.js already uses;
// re-reading it here (not fabricating anything new) lets presence be
// scored as accumulation-confirming when net flow is positive and as
// a real "whale selling" penalty when it's negative.

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

    const netBuy = trenchesEntry.net_buy_24h != null ? Number(trenchesEntry.net_buy_24h) : null;

    const reasons = [];

    const riskReasons = [];

    let raw;

    if(count >= 10){ raw = MAX_SCORE; reasons.push(`${count} smart/degen wallets present`); }
    else if(count >= 3){ raw = MAX_SCORE * 0.75; reasons.push(`${count} smart/degen wallets present`); }
    else if(count >= 1) raw = MAX_SCORE * 0.5;
    else raw = MAX_SCORE * 0.25;

    // Real whale-selling penalty: a meaningful smart/degen presence
    // combined with real net distribution on this token is a
    // materially worse signal than presence alone, not a neutral one.
    if(count >= 3 && netBuy != null && netBuy < 0){

        raw = MAX_SCORE * 0.1;

        reasons.length = 0;

        riskReasons.push(`${count} smart/degen wallets present but net selling ($${Math.abs(Math.round(netBuy)).toLocaleString()} net sold, 24h)`);

    }

    return { score: Math.round(raw), max: MAX_SCORE, hasData: true, reasons, riskReasons };

}

module.exports = { score, MAX_SCORE };
