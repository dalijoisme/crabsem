// services/intelligence/market/liquidity.js - Market Health
// sub-category. Always has real data (gmgn_tokens.liquidity/fdv).
// Generates CONFIRMATIONS, not reasons - liquidity never drives a
// BUY on its own, it only supports/weakens a participant-driven one.

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.market.weights.liquidity;

// Arjuna V3 (FINAL), Part 5 - HYBRID scoring: ratioFactor * absoluteFactor,
// both normalized to [0,1], multiplied together (not added). A "good
// ratio" on a tiny absolute liquidity figure (the ANGELBULL/SUKI-shaped
// case - $3,500 liquidity can still show a healthy ratio on a
// proportionally tiny market cap) can no longer reach a high score by
// ratio alone - the previous additive model let it. Large absolute
// liquidity is always rewarded over tiny liquidity, at any ratio.
function absoluteLiquidityFactor(liquidity){
    if(liquidity >= 100000) return 1.0;
    if(liquidity >= 50000) return 0.8;
    if(liquidity >= 25000) return 0.6;
    if(liquidity >= 10000) return 0.4;
    if(liquidity >= 5000) return 0.2;
    return 0.05;
}

function ratioFactor(ratio){
    if(ratio >= 0.15) return 1.0;
    if(ratio >= 0.08) return 0.7;
    if(ratio >= 0.03) return 0.4;
    return 0.1;
}

function score(token){

    const liquidity = Number(token.liquidity || 0);

    const fdv = Number(token.fdv || 0);

    const marketCap = Number(token.market_cap || 0);

    const valuationBasis = fdv > 0 ? fdv : marketCap;

    const confirmations = [];

    const riskReasons = [];

    const absFactor = absoluteLiquidityFactor(liquidity);

    if(liquidity < 5000) riskReasons.push(`Very low liquidity ($${Math.round(liquidity).toLocaleString()}) - high slippage/rug risk`);
    else if(liquidity >= 100000) confirmations.push("Liquidity confirms accumulation is well-supported");

    const ratio = valuationBasis > 0 ? liquidity / valuationBasis : null;
    const rFactor = ratio != null ? ratioFactor(ratio) : 0.4; // no valuation basis - neutral-ish, never guessed strong

    if(ratio != null){

        if(rFactor >= 1.0 && absFactor >= 0.4){

            confirmations.push("Liquidity well-backed relative to valuation");

        }
        else if(rFactor >= 1.0){

            // Same real case this module's own history already
            // documented (ANGELBULL: $3,194 liquidity) - a healthy
            // RATIO on a small ABSOLUTE figure is worded honestly, and
            // - unlike before - no longer scores as if it were fully
            // backed either.
            confirmations.push(`Liquidity ratio is healthy (${(ratio*100).toFixed(0)}% of valuation), but the absolute amount is still low ($${Math.round(liquidity).toLocaleString()}) - slippage risk remains`);

        }
        else if(rFactor <= 0.1){

            riskReasons.push(`Liquidity thin relative to valuation (${(ratio*100).toFixed(1)}%) - possible rug risk`);

        }

    }

    const hybridScore = MAX_SCORE * rFactor * absFactor;

    return {

        score: Math.min(MAX_SCORE, Math.round(hybridScore)),

        max: MAX_SCORE,

        hasData: true,

        confirmations,

        riskReasons,

        facts: { liquidity, backingRatio: ratio }

    };

}

module.exports = { score, MAX_SCORE };
