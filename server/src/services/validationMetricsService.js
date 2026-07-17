// services/validationMetricsService.js - read-only aggregation over
// recommendation_outcomes. Computes evidence, never tunes the
// engine - see server/INTELLIGENCE_ENGINE.md and the Sprint 2 brief
// ("collect evidence first"). Every metric below is reported as
// `null` (not a fabricated 0 or 50%) when the sample size is too
// small to mean anything.

const validationConfig = require("../config/validationConfig");
const recommendationLogRepository = require("../repositories/recommendationLogRepository");

function median(numbers){

    if(!numbers.length) return null;

    const sorted = [...numbers].sort((a,b) => a-b);

    const mid = Math.floor(sorted.length / 2);

    return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;

}

function mean(numbers){

    return numbers.length ? numbers.reduce((a,b) => a+b, 0) / numbers.length : null;

}

function accuracyFor(rows, action){

    const subset = rows.filter(r => r.action === action);

    if(subset.length < validationConfig.minSampleSizeForMetrics) return { sampleSize: subset.length, accuracy: null };

    return { sampleSize: subset.length, accuracy: mean(subset.map(r => r.win)) };

}

// BUY-class = STRONG BUY + BUY treated as "positive" predictions;
// actual-positive = the token's return over this horizon was > 0.
// Precision/Recall/FPR/FNR are all framed against that one binary
// split, independent of the per-action win definitions above.

function precisionRecallFor(rows){

    const isPredictedBuy = r => r.action === "STRONG BUY" || r.action === "BUY";

    const isActualUp = r => r.return_pct > 0;

    const truePositive = rows.filter(r => isPredictedBuy(r) && isActualUp(r)).length;
    const falsePositive = rows.filter(r => isPredictedBuy(r) && !isActualUp(r)).length;
    const falseNegative = rows.filter(r => !isPredictedBuy(r) && isActualUp(r)).length;
    const trueNegative = rows.filter(r => !isPredictedBuy(r) && !isActualUp(r)).length;

    const predictedPositive = truePositive + falsePositive;
    const actualPositive = truePositive + falseNegative;
    const actualNegative = trueNegative + falsePositive;

    return {

        precision: predictedPositive >= validationConfig.minSampleSizeForMetrics ? truePositive / predictedPositive : null,

        recall: actualPositive >= validationConfig.minSampleSizeForMetrics ? truePositive / actualPositive : null,

        falsePositiveRate: actualNegative >= validationConfig.minSampleSizeForMetrics ? falsePositive / actualNegative : null,

        falseNegativeRate: actualPositive >= validationConfig.minSampleSizeForMetrics ? falseNegative / actualPositive : null,

        confusionCounts: { truePositive, falsePositive, falseNegative, trueNegative }

    };

}

function metricsForHorizon(horizonLabel){

    const rows = recommendationLogRepository.findOutcomesForMetrics(horizonLabel);

    const returns = rows.map(r => r.return_pct).filter(v => v != null);

    const base = {

        horizon: horizonLabel,

        sampleSize: rows.length,

        winRate: rows.length >= validationConfig.minSampleSizeForMetrics ? mean(rows.map(r => r.win)) : null,

        averageReturnPct: rows.length >= validationConfig.minSampleSizeForMetrics ? mean(returns) : null,

        medianReturnPct: rows.length >= validationConfig.minSampleSizeForMetrics ? median(returns) : null,

        accuracyByAction: {

            strongBuy: accuracyFor(rows, "STRONG BUY"),

            buy: accuracyFor(rows, "BUY"),

            hold: accuracyFor(rows, "HOLD"),

            avoid: accuracyFor(rows, "AVOID")

        }

    };

    if(!rows.length) return base;

    return { ...base, ...precisionRecallFor(rows) };

}

function getValidationSummary(){

    return {

        generatedAt: new Date().toISOString(),

        totalRecommendationsLogged: recommendationLogRepository.countLogged(),

        totalOutcomesEvaluated: recommendationLogRepository.countOutcomes(),

        minSampleSizeForMetrics: validationConfig.minSampleSizeForMetrics,

        winDefinition: validationConfig.winDefinition,

        horizons: validationConfig.horizons.map(h => metricsForHorizon(h.label))

    };

}

module.exports = { getValidationSummary };
