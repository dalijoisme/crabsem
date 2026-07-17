// services/intelligence/market/priceStability.js - Market Health
// sub-category, and the market-side counterpart to the participant
// earliness curve. A token that has already moved a lot is
// inherently less "stable" (more reversal/exhaustion risk)
// regardless of direction - this independently reinforces the
// "prefer early over late" philosophy from a volatility-risk angle,
// on top of (not instead of) the participant-side earliness
// discount. Always has real data when price_change_1h exists.

const config = require("../../../config/scoringConfig");
const { lookupFactor } = require("../curveHelper");

const MAX_SCORE = config.market.weights.priceStability;

function score(token){

    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;

    const change5m = token.price_change_5m != null ? Number(token.price_change_5m) : null;

    if(change1h == null){

        return { score: Math.round(MAX_SCORE*config.market.neutralFraction), max: MAX_SCORE, hasData: false, confirmations: [], riskReasons: [] };

    }

    const stabilityFactor = lookupFactor(config.market.priceStabilityCurve, Math.abs(change1h), "maxAbsChange1h");

    const confirmations = [];

    const riskReasons = [];

    let points = MAX_SCORE * stabilityFactor;

    if(stabilityFactor >= 0.8){

        confirmations.push("Price action is still early - low exhaustion/reversal risk");

    }
    else if(stabilityFactor <= 0.2){

        riskReasons.push(`Price has already moved sharply (${change1h.toFixed(0)}% in 1h) - elevated reversal risk`);

    }

    if(change5m != null){

        const reversing = (change1h >= 0 && change5m < -5) || (change1h < 0 && change5m > 5);

        if(reversing){

            points *= 0.7;

            riskReasons.push("Short-term price action is reversing against the 1h trend");

        }

    }

    return { score: Math.round(points), max: MAX_SCORE, hasData: true, confirmations, riskReasons };

}

module.exports = { score, MAX_SCORE };
