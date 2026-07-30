// services/customObjectiveService.js - CRAB Trading Bot Constitution
// v1.0, Final Specification section 05 (Custom Objective Specification).
// Stateless AI Strategy Advisor. Never scores a token, never touches
// Production V2, never opens a position itself, never writes anything
// to the database - it only READS real, already-computed historical
// statistics and recommends WHICH Strategy Profile (an already-defined
// config bundle) the user might run. The user must still explicitly
// start the bot themselves (Constitution clause 7).
//
// Every number in the output traces back to a real, cited source:
//   - win rate / average ROI per confidence band ->
//     predictionMetricsService.getStatistics().confidenceCalibration -
//     the SAME numbers the CEO Dashboard already shows, never a new
//     model.
//   - trade frequency -> real closed trades (trading_bot_trades, or the
//     A/B benchmark ledger as the closest available real proxy when the
//     live bot doesn't have enough of its own history yet).
//   - drawdown -> abTestRepository.computeMaxDrawdownPct(), the one
//     real equity curve already recorded in this codebase.
//
// INSUFFICIENT DATA handling reuses the exact convention already shipped
// in services/ceoDashboardService.js's getConfidenceHealth(): below the
// sample-size floor, this returns a real "not enough evidence" answer
// instead of a fabricated percentage - never a number that looks precise
// but isn't backed by anything.

const predictionMetricsService = require("./predictionMetricsService");
const predictionValidationConfig = require("../config/predictionValidationConfig");
const strategyProfileConfig = require("../config/strategyProfileConfig");
const tradingBotRepository = require("../repositories/tradingBotRepository");
const abTestRepository = require("../repositories/abTestRepository");

// Same "usable" sample-size floor ceoDashboardService.getConfidenceHealth()
// already uses (>=10 real closed predictions in a confidence band) -
// reused, not reinvented.
const MIN_SAMPLE_SIZE = 10;
const PROBABILITY_MIN = 5;
const PROBABILITY_MAX = 95;

// Conservative-first: when more than one profile clears the bar,
// recommend the lowest-risk one that does.
const PROFILE_ORDER = ["STABLE", "BALANCED", "AGGRESSIVE"];
const RISK_LEVEL_BY_PROFILE = { STABLE: "LOW", BALANCED: "MEDIUM", AGGRESSIVE: "HIGH" };

function validateInput({ modal, target, deadline }){
    const errors = [];
    const modalNum = Number(modal);
    const targetNum = Number(target);
    const deadlineDate = deadline ? new Date(deadline) : null;

    if(!Number.isFinite(modalNum) || modalNum <= 0) errors.push("Modal (initial balance) must be a positive number.");
    if(!Number.isFinite(targetNum) || targetNum <= 0) errors.push("Target balance must be a positive number.");
    if(Number.isFinite(modalNum) && Number.isFinite(targetNum) && targetNum <= modalNum){
        errors.push("Target balance must be greater than modal (initial balance).");
    }
    if(!deadlineDate || Number.isNaN(deadlineDate.getTime())) errors.push("Deadline must be a valid date.");
    else if(deadlineDate.getTime() <= Date.now()) errors.push("Deadline must be in the future.");

    return { errors, modalNum, targetNum, deadlineDate };
}

// Standard compounding math - not a model, arithmetic. "What daily
// return, held constant, would carry modal to target by deadline."
function computeRequiredDailyReturnPct(modal, target, days){
    const requiredMultiple = target / modal;
    return (Math.pow(requiredMultiple, 1 / days) - 1) * 100;
}

function findBucketLabelForConfidence(minConfidence){
    const buckets = predictionValidationConfig.confidenceBuckets;
    const match = buckets.find(b => minConfidence >= b.min && minConfidence < b.max);
    return (match || buckets[buckets.length - 1]).label;
}

function deriveTradesPerDay(closedAtTimestamps){
    if(closedAtTimestamps.length < 2) return null;
    const times = closedAtTimestamps
        .map(ts => new Date(`${String(ts).replace(" ", "T")}Z`).getTime())
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    if(times.length < 2) return null;
    const spanDays = (times[times.length - 1] - times[0]) / 86400000;
    if(spanDays <= 0) return null;
    return times.length / spanDays;
}

// Real trade frequency: the live Trading Bot's own history first; the
// isolated A/B benchmark ledger (same real Production V2 + Dynamic Exit
// pipeline, see services/abTestEngine.js) as the closest available real
// proxy when the bot hasn't accumulated enough of its own history yet -
// exactly the fallback Final Spec section 05 step 3 describes. Never a
// synthetic/assumed frequency.
function realTradesPerDay(){

    const botTrades = tradingBotRepository.findRecentTrades(500).filter(t => t.closed_at);
    if(botTrades.length >= MIN_SAMPLE_SIZE){
        return deriveTradesPerDay(botTrades.map(t => t.closed_at));
    }

    const benchmarkTrades = [
        ...abTestRepository.findTrades("REGULAR"),
        ...abTestRepository.findTrades("HIGH_THROUGHPUT")
    ].filter(t => t.closed_at);

    return deriveTradesPerDay(benchmarkTrades.map(t => t.closed_at));

}

function evaluateProfile(profileName, requiredDailyReturnPct, tradesPerDay){

    const bundle = strategyProfileConfig.resolveProfile(profileName);
    const bucketLabel = findBucketLabelForConfidence(bundle.min_confidence);

    const stats = predictionMetricsService.getStatistics({});
    const band = stats.confidenceCalibration.find(b => b.label === bucketLabel);

    const sampleSize = band ? band.predictionCount : 0;

    if(!band || sampleSize < MIN_SAMPLE_SIZE || tradesPerDay == null || band.averageRoiPct == null){
        return { profileName, sufficient: false, sampleSize, bucketLabel };
    }

    const achievableDailyReturnPct = band.averageRoiPct * tradesPerDay;

    return {
        profileName,
        sufficient: true,
        sampleSize,
        bucketLabel,
        winRatePct: band.winRate != null ? band.winRate * 100 : null,
        averageRoiPct: band.averageRoiPct,
        tradesPerDay,
        achievableDailyReturnPct,
        meetsTarget: achievableDailyReturnPct >= requiredDailyReturnPct
    };

}

function buildInsufficientDataResult(profileEvaluations){
    const detail = profileEvaluations
        .map(p => `${p.profileName}: ${p.sampleSize} closed prediction(s) in the ${p.bucketLabel} confidence band (need >= ${MIN_SAMPLE_SIZE}) or not enough real trade history to measure trade frequency`)
        .join("; ");
    return {
        feasibility: "INSUFFICIENT_DATA",
        recommendedProfile: "STABLE", // safety default - never recommend Aggressive when data is insufficient
        probabilityEstimate: { value: null, basis: "Insufficient real historical data.", sampleSize: 0 },
        riskLevel: null,
        estimatedDrawdownPct: null,
        warning: "Not enough historical data yet to calculate a reliable probability. Defaulting to Stable until more data is available.",
        explanation: [`Currently available data: ${detail}.`]
    };
}

function clampProbability(value){
    return Math.min(PROBABILITY_MAX, Math.max(PROBABILITY_MIN, Math.round(value)));
}

function analyze({ modal, target, deadline }){

    const { errors, modalNum, targetNum, deadlineDate } = validateInput({ modal, target, deadline });
    if(errors.length) return { ok: false, errors };

    const days = (deadlineDate.getTime() - Date.now()) / 86400000;
    const requiredDailyReturnPct = computeRequiredDailyReturnPct(modalNum, targetNum, days);

    const tradesPerDay = realTradesPerDay();
    const evaluations = PROFILE_ORDER.map(name => evaluateProfile(name, requiredDailyReturnPct, tradesPerDay));

    const sufficient = evaluations.filter(e => e.sufficient);

    if(!sufficient.length){
        return { ok: true, result: buildInsufficientDataResult(evaluations) };
    }

    const meeting = sufficient.filter(e => e.meetsTarget);
    const insufficientNames = evaluations.filter(e => !e.sufficient).map(e => e.profileName);
    const dataCaveat = insufficientNames.length
        ? ` (${insufficientNames.join(", ")} don't have enough historical data yet to evaluate.)`
        : "";

    let result;

    if(!meeting.length){

        // UNREALISTIC - no profile with enough real evidence reaches the
        // target, including Aggressive when it had enough data to judge.
        const best = sufficient.reduce((a, b) => (a.achievableDailyReturnPct > b.achievableDailyReturnPct ? a : b));

        result = {
            feasibility: "UNREALISTIC",
            recommendedProfile: null,
            probabilityEstimate: { value: null, basis: "Target is beyond the range of available historical performance.", sampleSize: best.sampleSize },
            riskLevel: null,
            estimatedDrawdownPct: null,
            warning: `This target requires an average daily return of ${requiredDailyReturnPct.toFixed(2)}%, beyond historical performance even on the ${best.profileName} profile (${best.achievableDailyReturnPct.toFixed(2)}%).${dataCaveat}`,
            explanation: [
                `Required daily return: ${requiredDailyReturnPct.toFixed(2)}%.`,
                ...sufficient.map(e => `${e.profileName}: achievable daily return ~${e.achievableDailyReturnPct.toFixed(2)}% (win rate ${e.winRatePct.toFixed(0)}%, avg ROI ${e.averageRoiPct.toFixed(2)}%/trade, ~${e.tradesPerDay.toFixed(2)} trades/day, n=${e.sampleSize}).`)
            ]
        };

    }
    else{

        const onlyAggressiveMeets = meeting.every(e => e.profileName === "AGGRESSIVE");
        const chosen = meeting.find(e => PROFILE_ORDER.indexOf(e.profileName) === Math.min(...meeting.map(m => PROFILE_ORDER.indexOf(m.profileName))));

        const probabilityValue = clampProbability(100 * chosen.achievableDailyReturnPct / requiredDailyReturnPct);
        const drawdown = abTestRepository.computeMaxDrawdownPct(chosen.profileName);

        result = {
            feasibility: onlyAggressiveMeets ? "AMBITIOUS" : "REALISTIC",
            recommendedProfile: chosen.profileName,
            probabilityEstimate: {
                value: probabilityValue,
                basis: `Based on ${chosen.sampleSize} historical predictions in the ${chosen.bucketLabel} confidence band, ${chosen.winRatePct.toFixed(0)}% win rate, ${chosen.averageRoiPct.toFixed(2)}% average ROI per trade on the ${chosen.profileName} profile.`,
                sampleSize: chosen.sampleSize
            },
            riskLevel: RISK_LEVEL_BY_PROFILE[chosen.profileName],
            estimatedDrawdownPct: drawdown,
            warning: onlyAggressiveMeets
                ? `This target is only reached on the Aggressive profile, and assumes the historical average performance (${chosen.achievableDailyReturnPct.toFixed(2)}%/day) holds up.${dataCaveat}`
                : (dataCaveat ? dataCaveat.trim() : null),
            explanation: [
                `Required daily return: ${requiredDailyReturnPct.toFixed(2)}%.`,
                `${chosen.profileName}: achievable daily return ~${chosen.achievableDailyReturnPct.toFixed(2)}% (win rate ${chosen.winRatePct.toFixed(0)}%, avg ROI ${chosen.averageRoiPct.toFixed(2)}%/trade, ~${chosen.tradesPerDay.toFixed(2)} trades/day, n=${chosen.sampleSize}).`,
                drawdown != null
                    ? `Historical max drawdown (${chosen.profileName} profile): ${drawdown.toFixed(2)}%.`
                    : `No equity curve history yet for the ${chosen.profileName} profile - drawdown estimate not available.`
            ]
        };

    }

    return { ok: true, result };

}

// computeRequiredDailyReturnPct/findBucketLabelForConfidence/clampProbability
// are exported alongside analyze purely for direct unit testing (Final
// Spec section 18) - no other module calls them directly.
module.exports = { analyze, MIN_SAMPLE_SIZE, computeRequiredDailyReturnPct, findBucketLabelForConfidence, clampProbability };
