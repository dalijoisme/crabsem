// services/intelligence/market/security.js - Market Health
// sub-category. Only has real data if this token appears in
// gmgn_trenches OR has a cached on-demand /token/:address/security
// lookup. hasData:false with NO confirmations when neither exists -
// "security passed" is never claimed without a real check.

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.market.weights.security;

// `facts` (built by intelligenceEngine.js from whichever real source
// was available) is either null or:
// { isHoneypot, renouncedMint, renouncedFreezeAccount, rugRatio, source,
//   canBlacklist }
//
// canBlacklist: Arjuna V3 (FINAL), Part 6 - "Blacklist capability ->
// reject immediately." No field for this exists anywhere in GMGN's
// trenches/token raw payloads today (checked directly against this
// account's own real data - zero matches for any blacklist-shaped key)
// - the wiring below is real and will hard-reject the moment such a
// field becomes available, but it is a structural no-op today (never
// fabricates a rejection from data that doesn't exist).
const entryScoreConfig = require("../../../config/scoringConfig").entryScore;

function score(facts){

    if(!facts){

        return { score: Math.round(MAX_SCORE*config.market.neutralFraction), max: MAX_SCORE, hasData: false, confirmations: [], riskReasons: [], hardReject: false };

    }

    const confirmations = [];

    const riskReasons = [];

    let points = 0;

    let penalty = 0;

    let hardReject = false;

    if(facts.canBlacklist === true){
        riskReasons.push("Token contract has blacklist capability - rejected immediately");
        hardReject = true;
    }

    if(facts.isHoneypot === 0){ points += MAX_SCORE*0.3; confirmations.push("Security passed - not flagged as a honeypot"); }
    else if(facts.isHoneypot === 1) riskReasons.push("Flagged as a possible honeypot");

    // Arjuna V3 (FINAL), Part 6 - "increase penalties": not-renounced
    // mint/freeze authority are now explicit, named point penalties
    // (subtracted from the unified entry score directly - see
    // researchEngineFactory.js), not just a missed positive bonus
    // inside this module's own small pool. Renounced still earns the
    // same positive confirmation as before.
    if(facts.renouncedMint === 1){ points += MAX_SCORE*0.2; confirmations.push("Mint authority renounced"); }
    else if(facts.renouncedMint === 0){
        riskReasons.push("Mint authority not renounced - supply can still be inflated");
        penalty += entryScoreConfig.securityPenalty.mintNotRenounced;
    }

    if(facts.renouncedFreezeAccount === 1){ points += MAX_SCORE*0.2; confirmations.push("Freeze authority renounced"); }
    else if(facts.renouncedFreezeAccount === 0){
        riskReasons.push("Freeze authority not renounced - accounts can still be frozen");
        penalty += entryScoreConfig.securityPenalty.freezeNotRenounced;
    }

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

        riskReasons,

        // Arjuna V3 (FINAL), Part 6/7: entry-score-level penalty (points
        // out of the unified 100, not this module's own 10-point pool) -
        // consumed by researchEngineFactory.js's unified score
        // computation, never applied twice.
        entryScorePenalty: penalty,

        hardReject

    };

}

module.exports = { score, MAX_SCORE };
