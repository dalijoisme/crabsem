// services/intelligence/participant/walletProfitability.js - real
// historical PNL/winrate for the makers involved in this token's
// smart money/KOL activity, sourced from the same cached
// GET /v1/user/wallet_stats lookups as walletQuality.js. Same
// sparsity caveat applies - real and functional when data exists,
// "no data" otherwise.

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.participant.weights.walletProfitability;

function score(walletStatsList){

    if(!walletStatsList || !walletStatsList.length){

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

    const winrates = walletStatsList

        .map(s => s.pnl_stat?.winrate)

        .filter(w => w != null)

        .map(Number);

    if(!winrates.length){

        return {

            score: Math.round(MAX_SCORE * config.participant.neutralFraction),

            max: MAX_SCORE,

            hasData: false,

            reasons: [],

            riskReasons: []

        };

    }

    const avgWinrate = winrates.reduce((a,b)=>a+b,0) / winrates.length;

    let raw;

    if(avgWinrate >= 0.6){ raw = MAX_SCORE; reasons.push(`Involved wallets have a strong historical win rate (${(avgWinrate*100).toFixed(0)}%)`); }
    else if(avgWinrate >= 0.4) raw = MAX_SCORE * 0.6;
    else{ raw = MAX_SCORE * 0.15; riskReasons.push(`Involved wallets have a weak historical win rate (${(avgWinrate*100).toFixed(0)}%)`); }

    return { score: Math.round(raw), max: MAX_SCORE, hasData: true, reasons, riskReasons };

}

module.exports = { score, MAX_SCORE };
