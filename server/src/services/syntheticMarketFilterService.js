// services/syntheticMarketFilterService.js - Arjuna vNext sprint,
// Priority 1. A FINAL EXECUTION FILTER, not a new quality gate and not
// new scoring: Research -> Scoring -> Ranking -> Candidate BUY (entry
// gate already passed) -> this filter -> BUY/REJECT. Never runs before
// entryGateService.evaluateEntry() and never changes which tokens rank
// as candidates - it only ever vetoes an already-qualified candidate
// whose real, already-collected orderflow pattern looks synthetic
// (bot-driven/bundled/wash-traded), the SUKI-shaped case this sprint
// exists for.
//
// Every input is already-collected GMGN data (gmgn_trenches, refreshed
// by the existing trenches collector) - no new API call, no new
// network I/O, so this can never slow down or fail the BUY path the
// way an on-demand GMGN call could. Fails OPEN: missing/unparseable
// data never rejects a candidate (same "never fabricate a rejection"
// convention services/qualityGateService.js already uses) - this
// filter can only ever SUBTRACT synthetic-looking candidates from an
// already-qualified set, never add friction anywhere else.

const config = require("../config/syntheticMarketFilterConfig");

function clamp01(n){
    if(!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function normalizedField(raw, field, ceiling){
    const value = raw[field];
    if(value == null || !Number.isFinite(Number(value))) return 0; // no real data - never guessed as suspicious
    return clamp01(Number(value) / ceiling) * 100;
}

// Derived signal #1 - see config's own comment for the real-data basis.
function holderToSwapDiversityScore(trenchesEntry){
    const cfg = config.holderToSwapDiversity;
    const swaps = Number(trenchesEntry.swaps_24h) || 0;
    const holders = Number(trenchesEntry.holders) || 0;
    if(swaps < cfg.minSwapsForDiversityCheck) return 0; // too thin a sample to mean anything
    const ratio = holders / swaps;
    if(ratio >= cfg.healthyRatioCeiling) return 0;
    if(ratio <= cfg.badRatioFloor) return 100;
    return 100 * (cfg.healthyRatioCeiling - ratio) / (cfg.healthyRatioCeiling - cfg.badRatioFloor);
}

// Derived signal #2 - see config's own comment for the real-data basis.
// Deliberately only flags an unnaturally BALANCED split - a strong
// buy-side skew (genuine momentum) never scores here.
function buySellClusteringScore(trenchesEntry){
    const cfg = config.buySellClustering;
    const buys = Number(trenchesEntry.buys_24h) || 0;
    const sells = Number(trenchesEntry.sells_24h) || 0;
    const total = buys + sells;
    if(total < cfg.minTxForClusterCheck) return 0;
    const deviation = Math.abs((buys / total) - 0.5);
    if(deviation >= cfg.suspiciousBalanceBand) return 0;
    return 100 * (cfg.suspiciousBalanceBand - deviation) / cfg.suspiciousBalanceBand;
}

// The composite scoring itself, factored out from evaluateSyntheticMarketFilter
// below so services/dynamicExitService.js's Momentum Health Score (Priority
// 2 of the same sprint) can reuse the EXACT same real signal for its own
// "orderflow weakening / market structure deterioration" component instead
// of re-parsing gmgn_trenches.raw_json a second time with a second set of
// rules - one real computation of "how synthetic does this token's orderflow
// look right now", two callers (BUY-time veto here, HELD-position health
// there).
//
// trenchesEntry: the same gmgn_trenches row entryGateService.js already
// required to be non-null (MISSING_QUALITY_DATA gate) before a candidate
// can reach this filter at all - callers re-fetch it via
// gmgnTrenchesRepository.findByTokenAddress (a local SQLite read, not a
// GMGN API call) rather than threading it through the entry gate's
// return value, keeping entryGateService.js itself untouched.
//
// Returns { syntheticScore, breakdown, washFlagged } - never fails open by
// itself (caller decides pass/reject); returns an all-zero breakdown for
// missing/unparseable data.
function computeSyntheticBreakdown(trenchesEntry){

    if(!trenchesEntry) return { syntheticScore: 0, breakdown: {}, washFlagged: false };

    let raw = {};
    try{ raw = JSON.parse(trenchesEntry.raw_json || "{}"); }
    catch(e){ return { syntheticScore: 0, breakdown: {}, washFlagged: false }; }

    const breakdown = {
        botDegenRate: normalizedField(raw, "bot_degen_rate", config.p99Ceiling.botDegenRate),
        bundlerTraderAmountRate: normalizedField(raw, "bundler_trader_amount_rate", config.p99Ceiling.bundlerTraderAmountRate),
        ratTraderAmountRate: normalizedField(raw, "rat_trader_amount_rate", config.p99Ceiling.ratTraderAmountRate),
        entrapmentRatio: normalizedField(raw, "entrapment_ratio", config.p99Ceiling.entrapmentRatio),
        freshWalletRate: normalizedField(raw, "fresh_wallet_rate", config.p99Ceiling.freshWalletRate),
        suspectedInsiderHoldRate: normalizedField(raw, "suspected_insider_hold_rate", config.p99Ceiling.suspectedInsiderHoldRate),
        holderToSwapDiversity: holderToSwapDiversityScore(trenchesEntry),
        buySellClustering: buySellClusteringScore(trenchesEntry)
    };

    const weights = config.weights;
    const syntheticScore = Object.keys(weights).reduce((sum, key) => sum + (breakdown[key] || 0) * weights[key], 0);

    return { syntheticScore, breakdown, washFlagged: raw.is_wash_trading === true };

}

// Returns { pass, syntheticScore, breakdown, reasons } - reasons is a
// human-readable list for logging, always populated even on a pass
// (shows the top contributing signals, even if none crossed the line).
function evaluateSyntheticMarketFilter(token, trenchesEntry){

    if(!trenchesEntry){
        return { pass: true, syntheticScore: 0, breakdown: {}, reasons: ["No trenches data available - never fabricate a rejection"] };
    }

    const { syntheticScore, breakdown, washFlagged } = computeSyntheticBreakdown(trenchesEntry);

    const reasons = Object.entries(breakdown)
        .filter(([, score]) => score >= 40)
        .sort((a, b) => b[1] - a[1])
        .map(([key, score]) => `${key}=${score.toFixed(1)}`);

    if(washFlagged) reasons.unshift("GMGN is_wash_trading=true");

    const pass = !washFlagged && syntheticScore < config.rejectThreshold;

    if(!pass && reasons.length === 0){
        reasons.push(`compositeScore=${syntheticScore.toFixed(1)} >= threshold=${config.rejectThreshold}`);
    }

    return { pass, syntheticScore, breakdown, reasons, washFlagged };

}

module.exports = { evaluateSyntheticMarketFilter, computeSyntheticBreakdown };
