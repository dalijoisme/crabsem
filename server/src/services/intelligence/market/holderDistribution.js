// services/intelligence/market/holderDistribution.js - Market
// Health sub-category: raw holder count/concentration, distinct from
// participant/whale.js which is about WHO the holders are (smart
// money composition). This is purely about the DISTRIBUTION shape -
// count always real (gmgn_tokens.holders); concentration only real
// when this token appears in gmgn_trenches.
//
// Final Engine Evolution Specification - a Sprint 16 discount here
// (genuineParticipationFactor, keyed on fresh_wallet_rate) was removed.
// It assumed fresh-wallet-driven holder growth predicts worse real
// outcomes; Sprint 23's revalidation against realized_roi_pct (the
// correct, on-chain ground truth) found holderDistribution's own
// correlation with real outcome is strongly POSITIVE (+0.531, the
// strongest of any weighted module) - the opposite of what the discount
// assumed. Removing invalidated conservative-biasing logic, not adding
// new logic - this restores full conviction on real holder-count evidence.

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.market.weights.holderDistribution;

// Arjuna V3 (FINAL), Part 4 - holder count is now the SOLE basis for
// this module's score (real losses - SUKI/Rocketman/FruitCats/etc. -
// consistently occurred on extremely low-holder tokens). Concentration
// (top_10_holder_rate) is kept as observability (confirmations/
// riskReasons text) but no longer contributes points - the exact
// buckets below already reach MAX_SCORE at the top tier, leaving no
// room for a separate concentration bonus without exceeding it.
const HOLDER_COUNT_BUCKETS = [
    { min: 120, fraction: 1.00 },
    { min: 70, fraction: 10/15 },
    { min: 40, fraction: 6/15 },
    { min: 0, fraction: 0 }
];

function score(token, trenchesEntry){

    const holders = token.holders != null ? Number(token.holders) : null;

    const confirmations = [];

    const riskReasons = [];

    let countPoints = 0;

    if(holders != null){

        const bucket = HOLDER_COUNT_BUCKETS.find(b => holders >= b.min);
        countPoints = MAX_SCORE * bucket.fraction;

        if(holders >= 120) confirmations.push(`Broad holder base confirms distribution (${holders.toLocaleString()} holders)`);
        else if(holders < 40) riskReasons.push(`Very few holders (${holders}) - below the validated 40-holder floor, concentration/wash-trading risk`);

    }

    const hasConcentrationData = trenchesEntry && trenchesEntry.top_10_holder_rate != null;

    if(hasConcentrationData){

        const rate = Number(trenchesEntry.top_10_holder_rate);

        if(rate <= 0.15) confirmations.push(`Healthy holder distribution (top 10 hold ${(rate*100).toFixed(1)}%)`);
        else if(rate > 0.50) riskReasons.push(`High holder concentration (top 10 hold ${(rate*100).toFixed(1)}%)`);

    }

    return {

        score: Math.min(MAX_SCORE, Math.round(countPoints)),

        max: MAX_SCORE,

        hasData: holders != null,

        confirmations,

        riskReasons

    };

}

module.exports = { score, MAX_SCORE };
