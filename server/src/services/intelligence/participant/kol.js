// services/intelligence/participant/kol.js - same pattern as
// smartMoney.js (both the volume-significance blend and the
// earliness discount), sourced from gmgn_activity_feed
// (feed_type='kol'). See that file's header for the full reasoning.
//
// Final Engine Evolution - walletDiversityFactor below closes the one
// real gap between this module and smartMoney.js: both read the same
// activity-feed row shape (maker_address already present on every real
// row), but only smartMoney.js discounted a signal built from one
// repeated wallet vs many distinct ones. Reuses that exact, already-
// validated formula verbatim - not a new threshold, the same local,
// asymmetric self-check (floor 0.5, never a reject) already shipped
// elsewhere in this file's own sibling module.

const config = require("../../../config/scoringConfig");
const { lookupFactor } = require("../curveHelper");

const MAX_SCORE = config.participant.weights.kol;

const MIN_VOLUME = config.participant.minSignificantVolumeUsd.kol;

// Verbatim copy of smartMoney.js's own walletDiversityFactor - same
// evidence shape (activity-feed rows with maker_address), same formula,
// same floor. Full diversity keeps 100%, a single wallet repeating
// every trade caps at 50%.
function walletDiversityFactor(buys){
    if(!buys.length) return 1;
    const uniqueWallets = new Set(buys.map(a => a.maker_address).filter(Boolean)).size;
    if(!uniqueWallets) return 1;
    const ratio = uniqueWallets / buys.length;
    return 0.5 + 0.5 * ratio;
}

// Arjuna V4 Phase 2 (KOL Evolution) - realtimeSignal is OPTIONAL and
// TRAILING, same contract as smartMoney.js's own identical addition (see
// that file's header for the full reasoning). Every existing caller that
// doesn't pass a 3rd argument is byte-identical to before this sprint;
// this function's score/reasons/riskReasons logic is completely
// unchanged - realtimeSignal is only ever attached as `realtimeFacts`.
function score(activities, change1h, realtimeSignal){

    if(!activities || !activities.length){

        return {

            score: Math.round(MAX_SCORE * config.participant.neutralFraction),

            max: MAX_SCORE,

            hasData: false,

            reasons: [],

            riskReasons: [],

            realtimeFacts: realtimeSignal ?? null

        };

    }

    const buys = activities.filter(a => a.side === "buy");

    const sells = activities.filter(a => a.side === "sell");

    const buyUsd = buys.reduce((sum, a) => sum + Number(a.amount_usd || 0), 0);

    const sellUsd = sells.reduce((sum, a) => sum + Number(a.amount_usd || 0), 0);

    const totalVolume = buyUsd + sellUsd;

    const volumeConfidence = Math.min(1, totalVolume / MIN_VOLUME);

    const reasons = [];

    const riskReasons = [];

    let directionScore;

    const isAccumulating = buyUsd > sellUsd * 1.3;

    const isDistributing = sellUsd > buyUsd * 1.3;

    if(isAccumulating) directionScore = MAX_SCORE;
    else if(isDistributing) directionScore = MAX_SCORE * 0.15;
    else directionScore = MAX_SCORE * 0.5;

    const neutralPoint = MAX_SCORE * 0.5;

    let raw = neutralPoint + (directionScore - neutralPoint) * volumeConfidence;

    const diversityFactor = walletDiversityFactor(buys);
    raw *= diversityFactor;

    const uniqueBuyers = new Set(buys.map(a => a.maker_address).filter(Boolean)).size;

    if(isAccumulating && totalVolume >= MIN_VOLUME){

        reasons.push(`KOL accumulation detected ($${Math.round(buyUsd).toLocaleString()} bought vs $${Math.round(sellUsd).toLocaleString()} sold recently, ${uniqueBuyers} unique wallet(s))`);

    }
    else if(isAccumulating){

        reasons.push(`KOL leaning toward accumulation, but sample is small ($${Math.round(buyUsd).toLocaleString()} bought vs $${Math.round(sellUsd).toLocaleString()} sold - below the $${MIN_VOLUME} significance threshold)`);

    }
    else if(isDistributing){

        riskReasons.push(`KOL distribution detected ($${Math.round(sellUsd).toLocaleString()} sold vs $${Math.round(buyUsd).toLocaleString()} bought recently)`);

    }
    else{

        reasons.push(`KOL activity detected (${activities.length} recent trade(s))`);

    }

    if(buys.length >= 2 && diversityFactor < 0.75){

        riskReasons.push(`Buys concentrated in very few wallets (${uniqueBuyers} unique of ${buys.length} buy trades) - weaker signal than broad participation`);

    }

    // BUGFIX (engine-quality sprint) - see accumulation.js's identical
    // comment: magnitude, not signed value, or a crashing token was
    // wrongly scored as "early" and kept full participant credit.
    const earlinessFactor = lookupFactor(config.participant.earlinessCurve, Math.abs(change1h ?? 0), "maxChange1h");

    const finalScore = Math.round(raw * earlinessFactor);

    if(earlinessFactor < 0.5 && isAccumulating && totalVolume >= MIN_VOLUME){

        reasons[reasons.length-1] += " - discounted, price has already moved significantly";

    }

    return {
        score: finalScore, max: MAX_SCORE, hasData: true, reasons, riskReasons,
        // Additive observability only - see this function's own header.
        realtimeFacts: realtimeSignal ?? null
    };

}

module.exports = { score, MAX_SCORE };
