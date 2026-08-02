// services/intelligence/participant/smartMoney.js - real recent
// trades from smart-money-tagged wallets for this specific token
// (gmgn_activity_feed, feed_type='smart_money'). The feed only holds
// the most recent ~50 trades system-wide, so an empty result means
// "not in our recent sample", not "verified zero interest".
//
// Two independent real-data discounts apply:
// - Volume significance: a 100%-buy ratio built from $55 across 3
//   trades is nowhere near the same strength of evidence as the same
//   ratio built from $50,000 - the raw direction score is blended
//   toward neutral in proportion to how far short of
//   minSignificantVolumeUsd.smartMoney the sample is. (Found during
//   this sprint's live-data validation - see INTELLIGENCE_ENGINE.md.)
// - Earliness: smart money buying into a token that hasn't moved yet
//   is a genuine early signal; the same buying after a big run is
//   discounted (see config/scoringConfig.js for the philosophy).

const config = require("../../../config/scoringConfig");
const { lookupFactor } = require("../curveHelper");

const MAX_SCORE = config.participant.weights.smartMoney;

const MIN_VOLUME = config.participant.minSignificantVolumeUsd.smartMoney;

// Arjuna V3 (FINAL), Part 3 - "prioritise quality instead of
// transaction count... avoid rewarding repetitive trades from the same
// wallets." uniqueBuyerCount/buyCount ratio: 1 wallet placing 5 buys
// scores far worse than 5 distinct wallets placing 5 buys, even though
// raw buyUsd/trade-count could be identical - directly closes the
// wash-trading-shaped gap this sprint exists to fix. Real, already-on
// each activity row (maker_address, gmgn_activity_feed) - never a new
// fetch.
function walletDiversityFactor(buys){
    if(!buys.length) return 1; // nothing to penalize
    const uniqueWallets = new Set(buys.map(a => a.maker_address).filter(Boolean)).size;
    if(!uniqueWallets) return 1; // no real wallet identity data - never guess a penalty
    const ratio = uniqueWallets / buys.length;
    // Full diversity (every buy a different wallet) keeps 100% of the
    // otherwise-earned score; a single wallet repeating every trade
    // caps at 50% - a real discount, never a full zero (one real smart-
    // money wallet buying twice is still real signal, just weaker than
    // several independent ones agreeing).
    return 0.5 + 0.5 * ratio;
}

// walletStatsList (optional, Arjuna V3 Part 3): the SAME real cached
// on-demand wallet stats researchEngineFactory.js already gathers for
// walletProfitability.js (gatherCachedWalletStats -> GMGN's real
// wallet_stats pnl_stat.winrate - identical field walletProfitability.js
// itself already validates). Not individually keyed back to which
// specific buyer wallet each stat belongs to (the pooled
// creator+smartMoney+kol wallet list GMGN's own API doesn't return an
// address on), so this is a real average-quality signal for the
// wallets involved with this token, not a per-wallet match - same
// honest aggregation walletProfitability.js already uses, reused here
// (not a second implementation) so smartMoney's own score also
// reflects real historical performance, not just trade count.
function walletQualityFactor(walletStatsList){
    if(!walletStatsList?.length) return 1;
    const winrates = walletStatsList.map(s => s.pnl_stat?.winrate).filter(w => w != null).map(Number);
    if(!winrates.length) return 1;
    const avgWinrate = winrates.reduce((a, b) => a + b, 0) / winrates.length;
    // >=60% real historical win rate earns a modest +15% factor; <30%
    // applies a real discount down to -15%. Neutral (1.0) in between.
    if(avgWinrate >= 0.6) return 1.15;
    if(avgWinrate < 0.3) return 0.85;
    return 1;
}

function score(activities, change1h, walletStatsList){

    if(!activities || !activities.length){

        return {

            score: Math.round(MAX_SCORE * config.participant.neutralFraction),

            max: MAX_SCORE,

            hasData: false,

            reasons: [],

            riskReasons: []

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

    // Blend toward the neutral midpoint when volume is thin - a small
    // sample shouldn't swing the score as hard as a large one.

    const neutralPoint = MAX_SCORE * 0.5;

    let raw = neutralPoint + (directionScore - neutralPoint) * volumeConfidence;

    const diversityFactor = walletDiversityFactor(buys);
    const qualityFactor = walletQualityFactor(walletStatsList);
    raw *= diversityFactor * qualityFactor;

    const uniqueBuyers = new Set(buys.map(a => a.maker_address).filter(Boolean)).size;

    if(isAccumulating && totalVolume >= MIN_VOLUME){

        reasons.push(`Smart money accumulation detected ($${Math.round(buyUsd).toLocaleString()} bought vs $${Math.round(sellUsd).toLocaleString()} sold recently, ${uniqueBuyers} unique wallet(s))`);

    }
    else if(isAccumulating){

        reasons.push(`Smart money leaning toward accumulation, but sample is small ($${Math.round(buyUsd).toLocaleString()} bought vs $${Math.round(sellUsd).toLocaleString()} sold - below the $${MIN_VOLUME} significance threshold)`);

    }
    else if(isDistributing){

        riskReasons.push(`Smart money distribution detected ($${Math.round(sellUsd).toLocaleString()} sold vs $${Math.round(buyUsd).toLocaleString()} bought recently)`);

    }
    else{

        reasons.push(`Smart money activity detected (${activities.length} recent trade(s))`);

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

    return { score: Math.max(0, Math.min(MAX_SCORE, finalScore)), max: MAX_SCORE, hasData: true, reasons, riskReasons };

}

module.exports = { score, MAX_SCORE };
