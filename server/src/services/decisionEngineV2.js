// services/decisionEngineV2.js - Decision Engine V2 sprint ("Data-Driven
// Decision Engine"). Turns the base AI engine's Feature -> Score -> BUY
// pipeline into Feature -> Historical Success -> BUY/HOLD, per the
// approved 5-layer design:
//
//   Layer 1 - Feature scoring: UNCHANGED. This file never recomputes a
//             token's participant/market score - it consumes the base
//             engine's already-computed signal (action/confidence/risk/
//             reasons/riskReasons - the exact shape
//             scheduler/tradingBotScheduler.js's computeLiveByAddressForPhilosophy
//             already produces via scoringWorkerPool) as an opaque input.
//   Layer 2 - Feature combinations: services/featureNormalizer.js's
//             getCombinationKeys() (pairs + triplets, same convention as
//             server/scripts/audit-ai-performance.js's Section B).
//   Layer 3 - Historical performance lookup: buildHistoricalStatsIndex()/
//             lookupBestHistoricalMatch() below, read from real
//             trading_bot_trades/trading_bot_positions history - same
//             tables, same join, same win/ROI definitions the audit
//             script already uses (roi_pct > 0 = win, matching
//             tradingBotRepository.sumClosedTrades's own convention).
//   Layer 4 - Confidence blend: computeConfidenceV2() - configurable
//             weighted formula (config/decisionEngineV2Config.js),
//             sample-size-gated so a thin history can never dominate.
//   Layer 5 - Decision: decide() - historical win-rate/ROI can only ever
//             DOWNGRADE a BUY to HOLD, never upgrade a HOLD/AVOID to BUY
//             (the base engine's own hard safety gates - risk, quality,
//             freshness - are Layer 1's job and are never touched here).
//
// STANDALONE BY DESIGN, NOT YET WIRED IN: this module is not imported by
// scheduler/tradingBotScheduler.js, services/tradingBotEngine.js, or
// services/productionEngineResolver.js - per this sprint's own rules
// ("JANGAN mengubah Scheduler/TradeManager/..."), activating V2 as the
// live decision path is a deliberate, separate step for later, not done
// here. evaluateV2() is a pure function (given its inputs) safe to call
// from a test, a script, or - later, deliberately - the live pipeline.
//
// No database writes anywhere in this file. loadHistoricalTrades() is
// the only function that touches a DB handle, and it only ever SELECTs.

const { normalizeFeatureList, comboKey, getCombinationKeys } = require("./featureNormalizer");
const defaultConfig = require("../config/decisionEngineV2Config");

function mean(nums){
    const arr = nums.filter(n => n != null && Number.isFinite(n));
    if(!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(nums){
    const arr = nums.filter(n => n != null && Number.isFinite(n)).slice().sort((a, b) => a - b);
    if(!arr.length) return null;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function clamp(n, min, max){
    return Math.max(min, Math.min(max, n));
}

function round(n, dp = 2){
    return n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp;
}

// ---------------------------------------------------------------------
// Layer 3a - data loader (the only DB-touching function in this file).
// db: any object exposing .prepare(sql).all(params) (a real
// better-sqlite3 handle, or a test double) - injected, never imported
// module-level, so requiring this file has zero side effects and a unit
// test never needs a real database file.
// ---------------------------------------------------------------------
function loadHistoricalTrades(db, { userId = null } = {}){
    const userClause = userId != null ? "AND t.user_id = @userId" : "";
    return db.prepare(`
        SELECT t.roi_pct, t.duration_seconds, p.breakdown_json
        FROM trading_bot_trades t
        JOIN trading_bot_positions p ON p.id = t.position_id
        WHERE t.closed_at IS NOT NULL AND t.roi_pct IS NOT NULL AND p.breakdown_json IS NOT NULL ${userClause}
    `).all(userId != null ? { userId } : {});
}

function extractNormalizedReasons(breakdownJson){
    if(!breakdownJson) return null;
    let parsed;
    try{ parsed = JSON.parse(breakdownJson); }
    catch(e){ return null; }
    if(!Array.isArray(parsed.reasons)) return [];
    return normalizeFeatureList(parsed.reasons);
}

// ---------------------------------------------------------------------
// Layer 3b - pure builder: raw trade rows (already fetched, see
// loadHistoricalTrades) -> Map<comboKey, stats>. Same "win = roi_pct > 0"
// convention as tradingBotRepository.sumClosedTrades/the audit script -
// never a second definition of "win".
// ---------------------------------------------------------------------
function buildHistoricalStatsIndex(trades, { maxComboSize = defaultConfig.maxComboSize } = {}){
    const byCombo = new Map();

    for(const t of trades){
        const features = extractNormalizedReasons(t.breakdown_json);
        if(!features || !features.length) continue;

        const keys = getCombinationKeys(features, maxComboSize);
        for(const key of keys){
            if(!byCombo.has(key)) byCombo.set(key, []);
            byCombo.get(key).push(t);
        }
    }

    const index = new Map();
    for(const [key, ts] of byCombo){
        const wins = ts.filter(t => t.roi_pct > 0).length;
        const losses = ts.length - wins;
        index.set(key, {
            comboKey: key,
            n: ts.length,
            wins,
            losses,
            winRatePct: round((wins / ts.length) * 100),
            avgRoiPct: round(mean(ts.map(t => t.roi_pct))),
            medianRoiPct: round(median(ts.map(t => t.roi_pct)))
        });
    }
    return index;
}

// ---------------------------------------------------------------------
// Layer 3c - lookup: among every combination present in the CANDIDATE's
// own (normalized) reasons list, return whichever one exists in the
// historical index with the LARGEST sample size (n) - the most
// statistically supported real evidence available for this exact
// candidate, not merely the most specific (a triplet seen twice is
// weaker evidence than a pair seen 40 times). Ties broken toward the
// more specific (larger) combination. Returns null when nothing in the
// candidate's own feature set has ANY historical record at all - a real,
// honest "no evidence", never a fabricated 0.
// ---------------------------------------------------------------------
function lookupBestHistoricalMatch(historicalIndex, candidateReasons, { maxComboSize = defaultConfig.maxComboSize } = {}){
    const features = normalizeFeatureList(candidateReasons);
    if(!features.length) return null;

    const keys = getCombinationKeys(features, maxComboSize); // already sorted largest-combo-first
    let best = null;
    for(const key of keys){
        const stats = historicalIndex.get(key);
        if(!stats) continue;
        if(!best || stats.n > best.n) best = stats;
    }
    return best;
}

// ---------------------------------------------------------------------
// Layer 4 - confidence blend. Sample-size gating: sampleConfidenceFactor
// is 0 below sampleGating.minSampleHardFloor (historical ignored
// entirely) and ramps 0->1 up to minReliableSampleSize. Weight that
// isn't "earned" by sample size flows back onto baseScore - never
// silently discarded, and the three weights always sum to how much of
// `confidenceV2` is actually explained.
// ---------------------------------------------------------------------
function computeConfidenceV2(baseScore, historicalMatch, config = defaultConfig){
    const w = config.weights;
    const sumWeights = w.baseScore + w.historicalWinRate + w.expectedRoi;
    if(Math.abs(sumWeights - 1) > 1e-6){
        throw new Error(`decisionEngineV2Config.weights must sum to 1 (got ${sumWeights}) - fix the config, this is never silently renormalized.`);
    }

    if(!historicalMatch || baseScore == null){
        return { confidenceV2: baseScore, sampleConfidenceFactor: 0, roiScore: null, usedHistorical: false };
    }

    const { minSampleHardFloor, minReliableSampleSize } = config.sampleGating;
    const sampleConfidenceFactor = historicalMatch.n < minSampleHardFloor
        ? 0
        : clamp(historicalMatch.n / minReliableSampleSize, 0, 1);

    if(sampleConfidenceFactor === 0){
        return { confidenceV2: baseScore, sampleConfidenceFactor: 0, roiScore: null, usedHistorical: false };
    }

    const { neutralRoiPct, pctPerScorePoint } = config.roiToScore;
    const roiScore = clamp(50 + (historicalMatch.avgRoiPct - neutralRoiPct) / pctPerScorePoint, 0, 100);

    const historicalPortion = w.historicalWinRate + w.expectedRoi;
    const effectiveHistWeight = historicalPortion * sampleConfidenceFactor;
    const effectiveBaseWeight = w.baseScore + historicalPortion * (1 - sampleConfidenceFactor);
    const effectiveWinRateWeight = w.historicalWinRate * sampleConfidenceFactor;
    const effectiveRoiWeight = w.expectedRoi * sampleConfidenceFactor;

    const confidenceV2 = round(
        baseScore * effectiveBaseWeight +
        historicalMatch.winRatePct * effectiveWinRateWeight +
        roiScore * effectiveRoiWeight
    );

    return {
        confidenceV2,
        sampleConfidenceFactor: round(sampleConfidenceFactor, 4),
        roiScore: round(roiScore),
        usedHistorical: true,
        weightsUsed: { baseWeight: round(effectiveBaseWeight, 4), winRateWeight: round(effectiveWinRateWeight, 4), roiWeight: round(effectiveRoiWeight, 4) }
    };
}

// ---------------------------------------------------------------------
// Layer 5 - decision. Historical evidence can only ever DOWNGRADE toward
// HOLD, never upgrade a base HOLD/AVOID into a BUY - the base engine's
// own hard safety gates (risk/quality/freshness, Layer 1) are the only
// thing allowed to produce a BUY-tier action in the first place.
// ---------------------------------------------------------------------
function decide(baseSignal, historicalMatch, confidenceResult, config = defaultConfig){
    const reasoning = [];
    let action = baseSignal.action;

    if(!confidenceResult.usedHistorical){
        reasoning.push(
            historicalMatch
                ? `Sample historis terlalu kecil (n=${historicalMatch.n} < ${config.sampleGating.minSampleHardFloor}) - historical diabaikan, pakai scoring lama.`
                : "Tidak ada histori untuk kombinasi fitur ini - pakai scoring lama."
        );
        return { action, confidence: confidenceResult.confidenceV2, reasoning, fallbackToBaseScoring: true, historical: historicalMatch };
    }

    const isBuyTier = action === "BUY" || action === "STRONG BUY";
    const { minWinRateForBuyPct, minAvgRoiForBuyPct } = config.decisionOverrides;

    reasoning.push(`Historical combination win rate: ${historicalMatch.winRatePct}%`);
    reasoning.push(`Sample: ${historicalMatch.n} trades`);
    reasoning.push(`Expected ROI: ${historicalMatch.avgRoiPct >= 0 ? "+" : ""}${historicalMatch.avgRoiPct}%`);

    if(isBuyTier && historicalMatch.winRatePct < minWinRateForBuyPct){
        action = "HOLD";
        reasoning.push(`Downgraded to HOLD: historical win rate ${historicalMatch.winRatePct}% < ${minWinRateForBuyPct}% floor.`);
    }
    else if(isBuyTier && historicalMatch.avgRoiPct < minAvgRoiForBuyPct){
        action = "HOLD";
        reasoning.push(`Downgraded to HOLD: historical avg ROI ${historicalMatch.avgRoiPct}% is negative/below floor - combination historically loses.`);
    }

    return { action, confidence: confidenceResult.confidenceV2, reasoning, fallbackToBaseScoring: false, historical: historicalMatch };
}

// ---------------------------------------------------------------------
// Decision Trace / Explain Mode sprint. PURE, read-only: builds a
// structured explanation of how a decision was reached from data
// already computed by Layers 2-5 above - never recomputes anything,
// never influences action/confidence (evaluateV2 calls this AFTER
// decide() has already produced the final action - the trace can only
// ever describe that outcome, not change it). Every field the sprint
// asked for: base action/confidence, the historical combination found,
// sample size, historical win rate/ROI, each weighted
// bonus/penalty component actually applied, confidence before/after,
// and the final reasoning.
function buildTrace(baseSignal, historicalMatch, confidenceResult, decisionResult){
    const adjustments = [];

    if(confidenceResult.usedHistorical){
        const w = confidenceResult.weightsUsed;
        adjustments.push({
            component: "baseScore",
            value: baseSignal.confidence,
            weight: w.baseWeight,
            contribution: round(baseSignal.confidence * w.baseWeight)
        });
        adjustments.push({
            component: "historicalWinRate",
            value: historicalMatch.winRatePct,
            weight: w.winRateWeight,
            contribution: round(historicalMatch.winRatePct * w.winRateWeight)
        });
        adjustments.push({
            component: "expectedRoi (mapped to 0-100 score)",
            value: confidenceResult.roiScore,
            weight: w.roiWeight,
            contribution: round(confidenceResult.roiScore * w.roiWeight)
        });
    }

    return {
        baseAction: baseSignal.action,
        baseConfidence: baseSignal.confidence,
        historicalCombo: historicalMatch?.comboKey ?? null,
        sampleSize: historicalMatch?.n ?? 0,
        historicalWinRatePct: historicalMatch?.winRatePct ?? null,
        historicalAvgRoiPct: historicalMatch?.avgRoiPct ?? null,
        historicalMedianRoiPct: historicalMatch?.medianRoiPct ?? null,
        sampleConfidenceFactor: confidenceResult.sampleConfidenceFactor,
        usedHistorical: confidenceResult.usedHistorical,
        adjustments,
        confidenceBefore: baseSignal.confidence,
        confidenceAfter: confidenceResult.confidenceV2,
        finalAction: decisionResult.action,
        changedFromBase: decisionResult.action !== baseSignal.action,
        reasoning: decisionResult.reasoning
    };
}

// ---------------------------------------------------------------------
// Top-level orchestrator - wires Layers 2-5 together for one candidate.
// baseSignal: { action, confidence, risk, reasons, riskReasons } - the
// EXACT shape the base engine already produces (Layer 1, untouched).
// historicalIndex: Map from buildHistoricalStatsIndex().
// ---------------------------------------------------------------------
function evaluateV2(baseSignal, historicalIndex, config = defaultConfig){
    const historicalMatch = lookupBestHistoricalMatch(historicalIndex, baseSignal.reasons, { maxComboSize: config.maxComboSize });
    const confidenceResult = computeConfidenceV2(baseSignal.confidence, historicalMatch, config);
    const decision = decide(baseSignal, historicalMatch, confidenceResult, config);
    const trace = buildTrace(baseSignal, historicalMatch, confidenceResult, decision);

    return {
        action: decision.action,
        confidence: decision.confidence,
        risk: baseSignal.risk,
        baseAction: baseSignal.action,
        baseConfidence: baseSignal.confidence,
        historical: historicalMatch,
        sampleConfidenceFactor: confidenceResult.sampleConfidenceFactor,
        fallbackToBaseScoring: decision.fallbackToBaseScoring,
        reasoning: decision.reasoning,
        // Decision Trace / Explain Mode sprint - additive only. Nothing
        // above this line changed: action/confidence/reasoning are
        // computed exactly as before, trace merely describes them.
        trace
    };
}

module.exports = {
    loadHistoricalTrades,
    buildHistoricalStatsIndex,
    lookupBestHistoricalMatch,
    computeConfidenceV2,
    decide,
    buildTrace,
    evaluateV2,
    defaultConfig
};
