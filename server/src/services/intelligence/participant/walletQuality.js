// services/intelligence/participant/walletQuality.js - real wallet
// quality signal for the makers involved in this token's smart
// money/KOL activity (or its dev wallet), sourced from cached
// GET /v1/user/wallet_stats lookups (server/src/services/
// gmgnOndemandService.js). This is genuinely sparse right now: wallet
// stats are only cached when someone has explicitly queried that
// specific wallet on-demand, so most tokens will have no data here
// until the platform accumulates more on-demand lookups. The module
// is fully real and functional when data exists - it is not a stub.

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.participant.weights.walletQuality;

// `walletStatsList` = array of real GMGN wallet_stats response
// bodies already fetched by the orchestrator (see
// intelligenceEngine.js#gatherCachedWalletStats).

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

    let totalScore = 0;

    walletStatsList.forEach(stats => {

        const tags = stats.common?.tags || [];

        const tokenNum = stats.pnl_stat?.token_num ?? 0;

        let walletRaw = MAX_SCORE * 0.5;

        if(tags.includes("fresh_wallet")){

            walletRaw = MAX_SCORE * 0.25;

        }
        else if(tokenNum >= 20){

            walletRaw = MAX_SCORE * 0.9;

        }

        totalScore += walletRaw;

    });

    const avgScore = totalScore / walletStatsList.length;

    if(avgScore >= MAX_SCORE * 0.7){

        reasons.push(`Involved wallets show an established trading history (${walletStatsList.length} wallet(s) checked)`);

    }
    else if(avgScore <= MAX_SCORE * 0.3){

        riskReasons.push(`Involved wallets are mostly fresh/new (${walletStatsList.length} wallet(s) checked)`);

    }

    return { score: Math.round(avgScore), max: MAX_SCORE, hasData: true, reasons, riskReasons };

}

module.exports = { score, MAX_SCORE };
