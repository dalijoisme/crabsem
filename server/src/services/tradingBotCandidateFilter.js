// services/tradingBotCandidateFilter.js - Execution Mode (Regular /
// High Throughput) for the Trading Bot.
//
// THIS IS NOT AN ENGINE. It never computes a recommendation, a
// confidence, a risk label, or a trade plan - it does exactly one
// thing: given the SAME candidate token list tradingBotEngine.js was
// already going to hand to Production V2, decide what ORDER to hand
// them in. Production V2 (via liveRecommendationService), the Quality
// Gate, TP15, stop-loss, and the Recommendation Lifecycle are called
// identically afterwards, on every token, regardless of this file's
// output - nothing about their own logic is read, touched, or
// duplicated here.
//
// Why order matters at all: tradingBotEngine.runCycle() stops opening
// new positions once max_open_positions is reached. In REGULAR mode
// the candidate order is whatever gmgnTokenRepository.getAllTokens()
// returns (unchanged, original behavior). In HIGH_THROUGHPUT mode,
// candidates most likely to move within the next few minutes-to-an-
// hour are checked FIRST, so a limited number of position slots is
// spent on faster-moving opportunities instead of whatever happened to
// come first in the default DB order - Production V2 still has the
// final (and only) say on whether any of them is actually tradeable.
//
// Every input below is a real, already-collected field - nothing new
// is fetched from GMGN for this. Ranked (not summed) per factor, then
// combined, so tokens are never penalized by one factor's raw scale
// dominating another's (a token with huge volume_1h wouldn't otherwise
// automatically outrank a token with modest volume but explosive
// momentum).

const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");

function safeNumber(v){
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// One real, disclosed "how likely to move soon" factor set:
//   - momentum: |price_change_1h| - already moving over the last hour
//   - volatility: |price_change_5m| - moving RIGHT NOW, not an hour ago
//   - volume: volume_1h - real trading interest, not just a price wiggle
//   - trade velocity: gmgn_trenches.swaps_24h - how much real activity
//   - buy pressure: gmgn_trenches.buys_24h / (buys_24h + sells_24h)
function computeFactors(token, trenchesEntry){

    const momentum = Math.abs(safeNumber(token.price_change_1h) ?? 0);
    const volatility = Math.abs(safeNumber(token.price_change_5m) ?? 0);
    const volume = safeNumber(token.volume_1h) ?? 0;

    const swaps = trenchesEntry ? (safeNumber(trenchesEntry.swaps_24h) ?? 0) : 0;

    const buys = trenchesEntry ? (safeNumber(trenchesEntry.buys_24h) ?? 0) : 0;
    const sells = trenchesEntry ? (safeNumber(trenchesEntry.sells_24h) ?? 0) : 0;
    const buyPressure = (buys + sells) > 0 ? buys / (buys + sells) : 0.5; // neutral when no real data

    return { momentum, volatility, volume, velocity: swaps, buyPressure };

}

// Rank ascending-index = best (rank 0 is the highest raw value for
// that one factor). Ties share the same rank - never an arbitrary
// tie-break that would look like a fabricated distinction.
function rankByDescending(values){

    const sorted = [...values].sort((a, b) => b - a);
    return values.map(v => sorted.indexOf(v));

}

// Lower combined rank = higher priority. Equal weight across all five
// factors - a deliberately simple, transparent starting point (same
// spirit as the Quality Gate's own "unvalidated starting point"
// thresholds), not a tuned model.
function rankCandidates(tokens){

    if(!tokens.length) return tokens;

    const addresses = tokens.map(t => t.token_address);
    const trenchesByAddress = gmgnTrenchesRepository.findManyByTokenAddresses(addresses);

    const factorSets = tokens.map(t => computeFactors(t, trenchesByAddress.get(t.token_address)));

    const momentumRanks = rankByDescending(factorSets.map(f => f.momentum));
    const volatilityRanks = rankByDescending(factorSets.map(f => f.volatility));
    const volumeRanks = rankByDescending(factorSets.map(f => f.volume));
    const velocityRanks = rankByDescending(factorSets.map(f => f.velocity));
    const buyPressureRanks = rankByDescending(factorSets.map(f => f.buyPressure));

    const combined = tokens.map((token, i) => ({
        token,
        score: momentumRanks[i] + volatilityRanks[i] + volumeRanks[i] + velocityRanks[i] + buyPressureRanks[i]
    }));

    combined.sort((a, b) => a.score - b.score);

    return combined.map(c => c.token);

}

module.exports = { rankCandidates };
