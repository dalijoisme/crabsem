// services/intelligence/market/security.js - Market Health
// sub-category. Only has real data if this token appears in
// gmgn_trenches OR has a cached on-demand /token/:address/security
// lookup. hasData:false with NO confirmations when neither exists -
// "security passed" is never claimed without a real check.

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.market.weights.security;

// `facts` (built by intelligenceEngine.js from whichever real source
// was available) is either null or:
// { isHoneypot, renouncedMint, renouncedFreezeAccount, rugRatio, source }

function score(facts){

    if(!facts){

        return { score: Math.round(MAX_SCORE*config.market.neutralFraction), max: MAX_SCORE, hasData: false, confirmations: [], riskReasons: [] };

    }

    const confirmations = [];

    const riskReasons = [];

    let points = 0;

    if(facts.isHoneypot === 0){ points += MAX_SCORE*0.3; confirmations.push("Security passed - not flagged as a honeypot"); }
    else if(facts.isHoneypot === 1) riskReasons.push("Flagged as a possible honeypot");

    if(facts.renouncedMint === 1){ points += MAX_SCORE*0.2; confirmations.push("Mint authority renounced"); }
    else if(facts.renouncedMint === 0) riskReasons.push("Mint authority not renounced - supply can still be inflated");

    if(facts.renouncedFreezeAccount === 1){ points += MAX_SCORE*0.2; confirmations.push("Freeze authority renounced"); }
    else if(facts.renouncedFreezeAccount === 0) riskReasons.push("Freeze authority not renounced - accounts can still be frozen");

    if(facts.rugRatio != null){

        const ratio = Number(facts.rugRatio);

        if(ratio <= 0.15){ points += MAX_SCORE*0.3; confirmations.push("Low rug-risk score confirms security checks"); }
        else if(ratio <= 0.35) points += MAX_SCORE*0.15;
        else riskReasons.push(`Elevated rug-risk score (${(ratio*100).toFixed(0)}%)`);

    }

    return {

        score: Math.max(0, Math.min(MAX_SCORE, Math.round(points))),

        max: MAX_SCORE,

        hasData: true,

        source: facts.source,

        confirmations,

        riskReasons

    };

}

module.exports = { score, MAX_SCORE };
