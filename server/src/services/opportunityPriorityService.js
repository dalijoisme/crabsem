// services/opportunityPriorityService.js - CRAB Trading Bot Constitution
// v1.0, Final Specification section 03. Pure ranking layer - never
// scores a token, never decides BUY/REJECT (Production V2's gate,
// unchanged, already decided that before a token ever reaches here).
// Given the BUY Candidate list tradingBotEngine.js already produced,
// this decides ORDER only - the same non-invasive pattern already
// proven by tradingBotCandidateFilter.js, extended with real
// decision-log velocity data that module never had access to.
//
// Formula (Final Spec section 03, fixed): 5 factors, each ranked
// descending (rank 0 = best), summed into one combinedRank - ties
// share a rank, identical convention to tradingBotCandidateFilter's
// own rankByDescending(). Sorting always uses combinedRank;
// priorityScore is a display-only projection of the same ranks, never
// re-sorted on (avoids lossy rounding changing the real order).
//
// Every input is a real, already-collected or already-computed field -
// confidenceVelocity/participantScoreVelocity are plain subtraction
// over two real prediction_history rows, never a new score.

const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const predictionHistoryRepository = require("../repositories/predictionHistoryRepository");

const TIER_HEATING_MIN = 70;
const TIER_WARM_MIN = 40;
const TIER_RANK = { HEATING: 0, WARM: 1, NORMAL: 2 };

// Decision rows that mean "nothing new happened this time" - every
// other reason predictionValidationService.js's trigger-rule engine
// ever writes to prediction_history.trigger_reason means something
// measurably changed enough to be recorded (real freshness), including
// the dynamic "RECOMMENDATION_CHANGED_X_TO_Y" strings.
const COLD_TRIGGER_REASONS = new Set(["FIRST_DECISION_FOR_TOKEN", "FIXED_REFRESH_TIMEOUT"]);

function safeNumber(v){
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// Batch read, shared by Opportunity Priority AND EMI (services/emiService.js) -
// fetched ONCE per cycle by tradingBotEngine.js, never per-token, never
// twice for the same cycle.
function fetchBatchContext(tokens){
    const addresses = tokens.map(t => t.token_address);
    return {
        historyByToken: predictionHistoryRepository.findRecentByTokens(addresses, 2),
        trenchesByToken: gmgnTrenchesRepository.findManyByTokenAddresses(addresses)
    };
}

function computeFactors(token, historyRows, trenchesEntry){

    const row0 = historyRows?.[0] ?? null;
    const row1 = historyRows?.[1] ?? null;

    const confidenceVelocity = (row0?.confidence != null && row1?.confidence != null)
        ? row0.confidence - row1.confidence : 0;

    const participantScoreVelocity = (row0?.score != null && row1?.score != null)
        ? row0.score - row1.score : 0;

    const triggerHeat = (row0?.trigger_reason && !COLD_TRIGGER_REASONS.has(row0.trigger_reason)) ? 1 : 0;

    const priceVelocity = Math.abs(safeNumber(token.price_change_5m) ?? 0);

    const buys = trenchesEntry ? (safeNumber(trenchesEntry.buys_24h) ?? 0) : 0;
    const sells = trenchesEntry ? (safeNumber(trenchesEntry.sells_24h) ?? 0) : 0;
    const buyPressure = (buys + sells) > 0 ? buys / (buys + sells) : 0.5; // neutral when no real data

    return { confidenceVelocity, participantScoreVelocity, triggerHeat, priceVelocity, buyPressure };

}

// Rank ascending-index = best (rank 0 is the highest raw value for
// that one factor). Ties share the same rank - never an arbitrary
// tie-break.
function rankByDescending(values){
    const sorted = [...values].sort((a, b) => b - a);
    return values.map(v => sorted.indexOf(v));
}

function tierFromScore(priorityScore){
    if(priorityScore >= TIER_HEATING_MIN) return "HEATING";
    if(priorityScore >= TIER_WARM_MIN) return "WARM";
    return "NORMAL";
}

// Final Spec section 04: EMI never invents a new score - it can only
// push an already-computed Tier UP, never down, and never touches
// combinedRank/priorityScore themselves.
function applyEmiBump(tier, priorityScore, emiFlag){
    if(!emiFlag?.accelerating) return tier;
    if(TIER_RANK[tier] > TIER_RANK.WARM) tier = "WARM";
    if(priorityScore >= 55 && TIER_RANK[tier] > TIER_RANK.HEATING) tier = "HEATING";
    return tier;
}

// tokens: BUY Candidate list (already gated by Production V2 + confidence
// floor - unchanged). batchContext: fetchBatchContext(tokens)'s result.
// emiFlagsByAddress: optional Map(token_address -> {accelerating, reason})
// from services/emiService.js - only ever populated when emi_enabled.
function rank(tokens, batchContext, emiFlagsByAddress){

    if(!tokens.length) return [];

    const factorSets = tokens.map(t => computeFactors(
        t,
        batchContext.historyByToken.get(t.token_address),
        batchContext.trenchesByToken.get(t.token_address)
    ));

    const confidenceVelocityRanks = rankByDescending(factorSets.map(f => f.confidenceVelocity));
    const participantScoreVelocityRanks = rankByDescending(factorSets.map(f => f.participantScoreVelocity));
    const triggerHeatRanks = rankByDescending(factorSets.map(f => f.triggerHeat));
    const priceVelocityRanks = rankByDescending(factorSets.map(f => f.priceVelocity));
    const buyPressureRanks = rankByDescending(factorSets.map(f => f.buyPressure));

    // Worst possible rank sum this cycle - denominator for priorityScore's
    // 0-100 projection. Single-candidate cycles have nothing to rank
    // against (every factor is trivially rank 0) - guarded to avoid a
    // divide-by-zero, not a real distinct code path.
    const maxCombinedRank = tokens.length > 1 ? 5 * (tokens.length - 1) : 1;

    const combined = tokens.map((token, i) => {

        const combinedRank = confidenceVelocityRanks[i] + participantScoreVelocityRanks[i]
            + triggerHeatRanks[i] + priceVelocityRanks[i] + buyPressureRanks[i];

        const priorityScore = Math.round(100 * (1 - combinedRank / maxCombinedRank));

        let tier = tierFromScore(priorityScore);
        tier = applyEmiBump(tier, priorityScore, emiFlagsByAddress?.get(token.token_address));

        return { token, combinedRank, priorityScore, tier };

    });

    // Sort key: (possibly EMI-bumped) Tier first, combinedRank as
    // tiebreak within a tier - the only place EMI's flag changes
    // anything observable (never sizing, never the gate - see
    // services/emiService.js).
    combined.sort((a, b) => {
        const tierDelta = TIER_RANK[a.tier] - TIER_RANK[b.tier];
        return tierDelta !== 0 ? tierDelta : a.combinedRank - b.combinedRank;
    });

    return combined;

}

module.exports = { fetchBatchContext, rank, TIER_RANK, COLD_TRIGGER_REASONS };
