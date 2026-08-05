// services/intelligence/participant/accumulation.js - direct
// net-flow accumulation/distribution signal, from the real
// gmgn_trenches.net_buy_24h field (buys_24h minus sells_24h in USD,
// as returned by GMGN itself - not derived or estimated by us).
// Only has data when this token appears in gmgn_trenches.
//
// Same volume-significance and earliness discounts as smartMoney.js/
// kol.js - a small net_buy_24h shouldn't score identically to a
// large one just because the sign is the same, and real net buying
// on a token that hasn't moved yet is worth more than the same
// buying after a big run.
//
// Final Engine Evolution Specification - a Sprint 16 discount here
// (orderflowAuthenticityFactor, keyed on bot_degen_rate/rat_trader_amount_rate)
// was removed. It was built on the hypothesis that bot/coordinated-looking
// orderflow predicts worse real outcomes - Sprint 18's own direct causal
// test found the opposite (tokens with high bot_degen_rate real-outcome
// OUTPERFORMED low-bot_degen_rate tokens), and Sprint 23's revalidation
// against realized_roi_pct (the correct, on-chain ground truth) showed
// accumulation's own correlation with real outcome is ~0 (was reported as
// -0.338 under the wrong, quoted-price outcome label) - the problem this
// discount existed to fix does not survive contact with the real ground
// truth. Removing invalidated conservative-biasing logic, not adding new
// logic - this restores full conviction on real net-buy evidence.

const config = require("../../../config/scoringConfig");
const { lookupFactor } = require("../curveHelper");

const MAX_SCORE = config.participant.weights.accumulation;

const MIN_VOLUME = config.participant.minSignificantVolumeUsd.accumulation;

function score(trenchesEntry, change1h){

    if(!trenchesEntry || trenchesEntry.net_buy_24h == null){

        return {

            score: Math.round(MAX_SCORE * config.participant.neutralFraction),

            max: MAX_SCORE,

            hasData: false,

            reasons: [],

            riskReasons: []

        };

    }

    const netBuy = Number(trenchesEntry.net_buy_24h);

    const buys = Number(trenchesEntry.buys_24h || 0);

    const sells = Number(trenchesEntry.sells_24h || 0);

    const totalVolume = buys + sells; // trade count, not USD - used only as a data-presence signal here since GMGN doesn't give per-trade USD for trenches

    const volumeUsd = Math.abs(netBuy);

    const volumeConfidence = Math.min(1, volumeUsd / MIN_VOLUME);

    const reasons = [];

    const riskReasons = [];

    let directionScore = MAX_SCORE * 0.4;

    const dominance = totalVolume > 0 ? buys / Math.max(1, totalVolume) : 0.5;

    if(netBuy > 0 && buys > 0){

        if(dominance >= 0.65) directionScore = MAX_SCORE;
        else if(dominance >= 0.55) directionScore = MAX_SCORE * 0.7;
        else directionScore = MAX_SCORE * 0.45;

    }
    else if(netBuy < 0){

        directionScore = MAX_SCORE * 0.1;

    }

    const neutralPoint = MAX_SCORE * 0.4;

    let raw = neutralPoint + (directionScore - neutralPoint) * volumeConfidence;

    if(netBuy > 0 && volumeUsd >= MIN_VOLUME){

        reasons.push(`Net accumulation detected ($${Math.round(netBuy).toLocaleString()} net buys, 24h)`);

    }
    else if(netBuy > 0){

        reasons.push(`Slight net accumulation ($${Math.round(netBuy).toLocaleString()} net buys, 24h - below the $${MIN_VOLUME} significance threshold)`);

    }
    else if(netBuy < 0 && volumeUsd >= MIN_VOLUME){

        riskReasons.push(`Net distribution detected ($${Math.round(volumeUsd).toLocaleString()} net sells, 24h)`);

    }

    // BUGFIX (engine-quality sprint): this curve must be keyed on
    // magnitude, not signed value - lookupFactor walks buckets
    // low-to-high and returns the first whose maxChange1h the value
    // is <= to, so an unsigned negative change1h (e.g. a token down
    // -80%) satisfied the very first bucket (<=10) and was scored as
    // if it hadn't moved at all yet - the exact mechanism that let a
    // crashing token still earn full "early" credit toward a high
    // participant score. Magnitude is the correct question here
    // ("how far past the early stage is this token, either way") -
    // direction is handled separately, by market/priceStability.js's
    // reversal check and intelligenceEngine's structural downgrade.
    const earlinessFactor = lookupFactor(config.participant.earlinessCurve, Math.abs(change1h ?? 0), "maxChange1h");

    const finalScore = Math.round(raw * earlinessFactor);

    if(earlinessFactor < 0.5 && netBuy > 0 && volumeUsd >= MIN_VOLUME){

        reasons[reasons.length-1] += " - discounted, price has already moved significantly";

    }

    return { score: finalScore, max: MAX_SCORE, hasData: true, reasons, riskReasons };

}

module.exports = { score, MAX_SCORE };
