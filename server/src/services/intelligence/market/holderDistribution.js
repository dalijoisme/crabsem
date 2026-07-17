// services/intelligence/market/holderDistribution.js - Market
// Health sub-category: raw holder count/concentration, distinct from
// participant/whale.js which is about WHO the holders are (smart
// money composition). This is purely about the DISTRIBUTION shape -
// count always real (gmgn_tokens.holders); concentration only real
// when this token appears in gmgn_trenches.

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.market.weights.holderDistribution;

function score(token, trenchesEntry){

    const holders = token.holders != null ? Number(token.holders) : null;

    const confirmations = [];

    const riskReasons = [];

    let countPoints = MAX_SCORE*0.3;

    if(holders != null){

        if(holders >= 2000){ countPoints = MAX_SCORE*0.6; confirmations.push(`Broad holder base confirms distribution (${holders.toLocaleString()} holders)`); }
        else if(holders >= 500) countPoints = MAX_SCORE*0.45;
        else if(holders >= 100) countPoints = MAX_SCORE*0.3;
        else if(holders < 20) riskReasons.push(`Very few holders (${holders}) - concentration risk`);

    }

    let concentrationPoints = MAX_SCORE*0.15;

    const hasConcentrationData = trenchesEntry && trenchesEntry.top_10_holder_rate != null;

    if(hasConcentrationData){

        const rate = Number(trenchesEntry.top_10_holder_rate);

        if(rate <= 0.15){ concentrationPoints = MAX_SCORE*0.4; confirmations.push(`Healthy holder distribution (top 10 hold ${(rate*100).toFixed(1)}%)`); }
        else if(rate <= 0.30) concentrationPoints = MAX_SCORE*0.25;
        else if(rate > 0.50) riskReasons.push(`High holder concentration (top 10 hold ${(rate*100).toFixed(1)}%)`);

    }

    return {

        score: Math.min(MAX_SCORE, Math.round(countPoints + concentrationPoints)),

        max: MAX_SCORE,

        hasData: holders != null,

        confirmations,

        riskReasons

    };

}

module.exports = { score, MAX_SCORE };
