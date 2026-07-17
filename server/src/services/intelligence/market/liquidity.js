// services/intelligence/market/liquidity.js - Market Health
// sub-category. Always has real data (gmgn_tokens.liquidity/fdv).
// Generates CONFIRMATIONS, not reasons - liquidity never drives a
// BUY on its own, it only supports/weakens a participant-driven one.

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.market.weights.liquidity;

function score(token){

    const liquidity = Number(token.liquidity || 0);

    const fdv = Number(token.fdv || 0);

    const marketCap = Number(token.market_cap || 0);

    const valuationBasis = fdv > 0 ? fdv : marketCap;

    const confirmations = [];

    const riskReasons = [];

    let liquidityPoints = 0;

    if(liquidity >= 100000){ liquidityPoints = MAX_SCORE*0.5; confirmations.push("Liquidity confirms accumulation is well-supported"); }
    else if(liquidity >= 50000) liquidityPoints = MAX_SCORE*0.4;
    else if(liquidity >= 25000) liquidityPoints = MAX_SCORE*0.3;
    else if(liquidity >= 10000) liquidityPoints = MAX_SCORE*0.2;
    else if(liquidity >= 5000) liquidityPoints = MAX_SCORE*0.1;
    else riskReasons.push(`Very low liquidity ($${Math.round(liquidity).toLocaleString()}) - high slippage/rug risk`);

    let backingPoints = MAX_SCORE*0.1;

    if(valuationBasis > 0){

        const ratio = liquidity / valuationBasis;

        if(ratio >= 0.15){ backingPoints = MAX_SCORE*0.5; confirmations.push("Liquidity well-backed relative to valuation"); }
        else if(ratio >= 0.08) backingPoints = MAX_SCORE*0.35;
        else if(ratio >= 0.03) backingPoints = MAX_SCORE*0.2;
        else{ backingPoints = MAX_SCORE*0.05; riskReasons.push(`Liquidity thin relative to valuation (${(ratio*100).toFixed(1)}%) - possible rug risk`); }

    }

    return {

        score: Math.min(MAX_SCORE, Math.round(liquidityPoints + backingPoints)),

        max: MAX_SCORE,

        hasData: true,

        confirmations,

        riskReasons,

        facts: { liquidity, backingRatio: valuationBasis > 0 ? liquidity/valuationBasis : null }

    };

}

module.exports = { score, MAX_SCORE };
