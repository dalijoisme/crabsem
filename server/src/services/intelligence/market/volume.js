// services/intelligence/market/volume.js - Market Health
// sub-category: 1h trading activity relative to liquidity, as a
// CONFIRMATION signal only (real trading is happening, market can
// actually absorb size) - never the reason a token is recommended.
// Always has real data (gmgn_tokens.volume_1h/liquidity).

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.market.weights.volume;

function score(token){

    const liquidity = Number(token.liquidity || 0);

    const volume1h = Number(token.volume_1h || 0);

    const confirmations = [];

    const riskReasons = [];

    if(liquidity <= 0){

        return { score: 0, max: MAX_SCORE, hasData: true, confirmations, riskReasons };

    }

    const ratio = volume1h / liquidity;

    let points;

    if(ratio >= 1){ points = MAX_SCORE; confirmations.push("Real trading volume confirms active market participation"); }
    else if(ratio >= 0.3) points = MAX_SCORE*0.6;
    else if(ratio >= 0.05) points = MAX_SCORE*0.3;
    else{ points = 0; riskReasons.push("Very little 1h trading activity relative to liquidity"); }

    return { score: Math.round(points), max: MAX_SCORE, hasData: true, confirmations, riskReasons };

}

module.exports = { score, MAX_SCORE };
