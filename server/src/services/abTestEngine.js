// services/abTestEngine.js - FINAL DECISION BENCHMARK. Regular (real
// Trading Bot production pipeline, unmodified) vs the Momentum Hunter
// + tournament-methodology replica - now sharing ONE identical Dynamic
// Exit rule (see dynamicExitService.js) so the comparison isolates
// ENTRY methodology only, exactly as requested. Production V2,
// Momentum Hunter, and researchEngineFactory.js are not imported for
// modification anywhere in this file - read-only calls only.
//
// REGULAR - unchanged signal source: Production V2 -> decision log ->
// liveRecommendationService (decay/lifecycle) -> Quality Gate ->
// min_confidence floor -> cooldown -> already-open guard.
//
// HIGH_THROUGHPUT (tournament replica) - unchanged signal source:
// researchEngineFactory's momentumHunter called directly and fresh
// every cycle, no decision log, no decay, no Quality Gate, no
// confidence floor. One entry per token, ever (the tournament's own
// real rule).
//
// POSITION SIZING (both profiles, identical, per this benchmark's
// rules) - 10% of TOTAL EQUITY (cash + open market value), not
// available cash, capped at $150, floored at $10.
//
// EXIT (both profiles, identical) - dynamicExitService.evaluateDynamicExit:
// TP15 is a minimum target, not a hard stop; a position that reaches
// +15% keeps running while real momentum evidence still supports it,
// and exits the moment that evidence weakens. Native dynamic stop-loss
// and an engine-reversal check apply throughout, same as before.

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const tokenLastDecisionRepository = require("../repositories/tokenLastDecisionRepository");
const abTestRepository = require("../repositories/abTestRepository");
const liveRecommendationService = require("./liveRecommendationService");
const qualityGateService = require("./qualityGateService");
const productionEngineResolver = require("./productionEngineResolver");
const factory = require("./researchEngineFactory");
const tradePlanService = require("./tradePlanService");
const dynamicExitService = require("./dynamicExitService");
const { computeRoiPct } = require("./roiCalculator");

const TEST_CONFIG = {
    initial_capital: 150,
    position_size_pct_of_equity: 10,
    max_position_size: 150,
    min_order_size: 10,
    fee_pct: 1,
    min_confidence: 60,
    min_decay_fraction: 0.90,
    cooldown_win_minutes: 5,
    cooldown_loss_minutes: 30,
    cooldown_reversal_minutes: 15,
    cooldown_default_minutes: 10
};

const TOURNAMENT_BUY_FEE_PCT = 1;
const TOURNAMENT_SELL_FEE_PCT = 1;

const PROFILES = ["REGULAR", "HIGH_THROUGHPUT"];

const NEUTRAL_STUB_SIGNAL = { action: "HOLD", confidence: 0, risk: "HIGH" };

let momentumHunterEngineCache = null;
function getMomentumHunterEngine(){
    if(!momentumHunterEngineCache){
        momentumHunterEngineCache = factory.buildEngines().find(e => e.key === "momentumHunter");
    }
    return momentumHunterEngineCache;
}

function minutesSince(sqliteTimestamp){
    if(!sqliteTimestamp) return Infinity;
    const then = new Date(`${String(sqliteTimestamp).replace(" ", "T")}Z`).getTime();
    return Math.max(0, (Date.now() - then) / 60000);
}

// Position size: 10% of TOTAL EQUITY (not available cash), capped and
// floored - identical formula, both profiles.
function computeSizeUsd(equity){
    return Math.min(TEST_CONFIG.max_position_size, equity * (TEST_CONFIG.position_size_pct_of_equity / 100));
}

// =====================================
// REGULAR - entry logic only (real production pipeline, unchanged)
// =====================================

function requiredCooldownMinutes(lastTrade){
    if(!lastTrade) return 0;
    const reason = lastTrade.reason || "";
    if(reason === "TAKE_PROFIT" || reason === "MOMENTUM_WEAKENING") return TEST_CONFIG.cooldown_win_minutes;
    if(reason === "STOP_LOSS") return TEST_CONFIG.cooldown_loss_minutes;
    if(reason === "REVERSAL") return TEST_CONFIG.cooldown_reversal_minutes;
    return TEST_CONFIG.cooldown_default_minutes;
}

function passesReentryScrutiny(token){
    const active = productionEngineResolver.getActiveEngine();
    const signal = active.analyzeToken(token);
    return (signal.selfValidation?.redFlags?.length || 0) === 0;
}

function evaluateEntryRegular(profile, token){

    const live = liveRecommendationService.resolveLiveRecommendation(token, NEUTRAL_STUB_SIGNAL);

    if(!live.hasDecision) return { eligible: false, reason: "NO_ENGINE_DECISION_YET" };
    if(live.excludeFromTrending) return { eligible: false, reason: `HARD_EXCLUDED_${live.exclusionReason}` };
    if(live.action !== "BUY" && live.action !== "STRONG BUY") return { eligible: false, reason: `NOT_A_BUY_TIER_${live.action}` };
    if(live.decayFraction < TEST_CONFIG.min_decay_fraction) return { eligible: false, reason: "DECISION_TOO_STALE" };
    if(live.confidence < TEST_CONFIG.min_confidence) return { eligible: false, reason: "CONFIDENCE_BELOW_FLOOR" };

    const quality = qualityGateService.passesQualityGate(token);
    if(!quality.pass) return { eligible: false, reason: `QUALITY_GATE_${quality.reason}` };

    if(abTestRepository.findOpenPositionForToken(profile, token.token_address)){
        return { eligible: false, reason: "ALREADY_OPEN_FOR_TOKEN" };
    }

    const lastTrade = abTestRepository.findLastTradeForToken(profile, token.token_address);
    const cooldownNeeded = requiredCooldownMinutes(lastTrade);

    if(lastTrade && minutesSince(lastTrade.closed_at) < cooldownNeeded){
        return { eligible: false, reason: `COOLDOWN_ACTIVE_${lastTrade.reason || "UNKNOWN"}` };
    }

    if(lastTrade && !passesReentryScrutiny(token)){
        return { eligible: false, reason: "REENTRY_STRUCTURAL_RED_FLAG" };
    }

    return { eligible: true, live };

}

function openPositionRegular(profile, token, live, equity, availableCash){

    const sizeUsd = computeSizeUsd(equity);
    if(sizeUsd < TEST_CONFIG.min_order_size || sizeUsd > availableCash) return { opened: false, reason: "INSUFFICIENT_AVAILABLE_CASH" };

    const entryPrice = Number(token.price) || null;
    if(!entryPrice || entryPrice <= 0) return { opened: false, reason: "NO_REAL_PRICE" };

    const activeEngine = productionEngineResolver.getActiveEngine();
    const last = tokenLastDecisionRepository.findByToken(token.token_address);

    const signalStub = {
        participantScore: last?.last_participant_score ?? 50,
        risk: live.risk,
        confidence: live.confidence
    };

    const riskBands = activeEngine.buildRiskBands(token, signalStub);
    if(!riskBands) return { opened: false, reason: "NO_RISK_BANDS_AVAILABLE" };

    abTestRepository.insertPosition({
        profile, tokenAddress: token.token_address, tokenSymbol: token.symbol,
        entryPrice, sizeUsd, confidence: live.confidence,
        targetPrice: riskBands.target.price, targetMarketCap: riskBands.target.marketCap,
        stopLossPrice: riskBands.stopLoss.price, stopLossMarketCap: riskBands.stopLoss.marketCap,
        lastVolume1h: token.volume_1h != null ? Number(token.volume_1h) : null
    });

    return { opened: true, sizeUsd };

}

// =====================================
// HIGH_THROUGHPUT (tournament replica) - entry logic only
// =====================================

function evaluateEntryTournament(profile, token, signal){

    if(!signal) return { eligible: false, reason: "NO_SIGNAL" };
    if(signal.action !== "BUY" && signal.action !== "STRONG BUY") return { eligible: false, reason: `NOT_A_BUY_TIER_${signal.action}` };

    if(abTestRepository.hasEverOpened(profile, token.token_address)){
        return { eligible: false, reason: "ALREADY_OPENED_EVER" };
    }

    const riskBands = tradePlanService.buildRiskBands(token, signal);
    if(!riskBands) return { eligible: false, reason: "NO_RISK_BANDS_AVAILABLE" };

    return { eligible: true, riskBands };

}

function openPositionTournament(profile, token, riskBands, equity, availableCash){

    const notional = computeSizeUsd(equity);
    if(notional < TEST_CONFIG.min_order_size) return { opened: false, reason: "INSUFFICIENT_AVAILABLE_CASH" };

    const entryPrice = Number(token.price) || null;
    if(!entryPrice || entryPrice <= 0) return { opened: false, reason: "NO_REAL_PRICE" };

    const buyFee = notional * (TOURNAMENT_BUY_FEE_PCT / 100);
    if(notional + buyFee > availableCash) return { opened: false, reason: "INSUFFICIENT_AVAILABLE_CASH" };

    const stopLossPrice = riskBands.stopLoss.price;

    abTestRepository.insertPosition({
        profile, tokenAddress: token.token_address, tokenSymbol: token.symbol,
        entryPrice, sizeUsd: notional, confidence: null,
        targetPrice: null, targetMarketCap: null,
        stopLossPrice, stopLossMarketCap: riskBands.stopLoss.marketCap,
        lastVolume1h: token.volume_1h != null ? Number(token.volume_1h) : null
    });

    return { opened: true, sizeUsd: notional, buyFee };

}

// =====================================
// SHARED CLOSE LOGIC - identical Dynamic Exit for both profiles
// =====================================

// Arjuna V4 (Sprint 11) bugfix: Arjuna V3 (Sprint 10) replaced
// dynamicExitService.evaluateDynamicExit's whole signature/return shape
// ({shouldClose,reason} -> {action,sellFraction,reason}) but this file
// was never updated to match - result.shouldClose has been `undefined`
// (always falsy) ever since, silently meaning this benchmark's own
// positions never closed at all. Fixed here: the current signature
// ({position, token, trenchesEntry} - engineAction/stopLossPrice are no
// longer read at all, the REVERSAL check that used to need a fresh
// engine re-score is gone from the new deterministic state machine, a
// real efficiency win too) and the action-based return.
//
// ab_test_positions/ab_test_trades (abTestRepository.js) predate Arjuna
// V3's partial-exit capability and are out of this sprint's explicit
// scope to extend - a SELL_PARTIAL (TP1) is treated as a full close
// here, same documented fallback services/tradeManager.js's own
// partialClose() already uses for repositories without partial-close
// support (e.g. the Benchmark Harness). This benchmark will show a full
// TP1 exit where live trading shows an 80%-then-Free-Ride split -
// acceptable for a research/comparison tool, never live money.
function closeIfDue(profile, position, token, trenchesEntry){

    const result = dynamicExitService.evaluateDynamicExit({ position, token, trenchesEntry });

    const mfePct = Math.max(position.mfe_pct || 0, result.roiPct);
    const maePct = Math.min(position.mae_pct || 0, result.roiPct);
    const currentVolume1h = token.volume_1h != null ? Number(token.volume_1h) : position.last_volume_1h;

    abTestRepository.updatePositionTracking(position.id, {
        currentPrice: result.currentPrice, mfePct, maePct, lastVolume1h: currentVolume1h
    });

    if(result.action === "HOLD") return { closed: false };

    return finalizeClose(profile, position, result.currentPrice, result.reason);

}

function finalizeClose(profile, position, exitPrice, reason){

    // Arjuna V4 (Sprint 11), Part 1: THE single ROI formula - see
    // services/roiCalculator.js's own header comment. ab-test never has
    // a real on-chain swap (always a simulation), so this IS the
    // official ROI for this table, same as before - just no longer a
    // second, independently-drifting inline copy of the formula.
    const roiPct = computeRoiPct(position.entry_price, exitPrice);

    let feeUsd;
    if(profile === "HIGH_THROUGHPUT"){
        // Tournament's own fee convention: separate buy fee (already
        // spent at open) + sell fee on gross exit value.
        const grossExitValue = position.size_usd * (exitPrice / position.entry_price);
        const sellFee = grossExitValue * (TOURNAMENT_SELL_FEE_PCT / 100);
        const buyFee = position.size_usd * (TOURNAMENT_BUY_FEE_PCT / 100);
        feeUsd = buyFee + sellFee;
    }
    else{
        feeUsd = position.size_usd * (TEST_CONFIG.fee_pct / 100) * 2; // Regular's own real fee formula, entry+exit
    }

    abTestRepository.closePosition(position, { exitPrice, roiPct, feeUsd, reason });

    return { closed: true, reason, roiPct };

}

// =====================================
// SHARED CYCLE DRIVER
// =====================================

function runCycleForProfile(profile, tokens, byAddress, momentumSignalsByAddress, trenchesByAddress){

    let opened = 0, closed = 0, skipped = 0;
    const skipReasons = {};

    const openPositions = abTestRepository.findOpenPositions(profile);
    for(const position of openPositions){
        const token = byAddress.get(position.token_address);
        if(!token) continue;
        const trenchesEntry = trenchesByAddress.get(position.token_address) || null;
        const result = closeIfDue(profile, position, token, trenchesEntry);
        if(result.closed) closed++;
    }

    const summary = abTestRepository.summarize(profile, TEST_CONFIG.initial_capital);
    let availableCash = summary.availableCash;
    let equity = summary.equity;

    for(const token of tokens){

        if(availableCash < TEST_CONFIG.min_order_size) break;

        if(profile === "HIGH_THROUGHPUT"){

            const signal = momentumSignalsByAddress.get(token.token_address);
            const evaluation = evaluateEntryTournament(profile, token, signal);

            if(!evaluation.eligible){
                skipped++;
                skipReasons[evaluation.reason] = (skipReasons[evaluation.reason] || 0) + 1;
                continue;
            }

            const result = openPositionTournament(profile, token, evaluation.riskBands, equity, availableCash);

            if(result.opened){
                opened++;
                availableCash -= (result.sizeUsd + result.buyFee);
            }
            else{
                skipped++;
                skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;
            }

        }
        else{

            const evaluation = evaluateEntryRegular(profile, token);

            if(!evaluation.eligible){
                skipped++;
                skipReasons[evaluation.reason] = (skipReasons[evaluation.reason] || 0) + 1;
                continue;
            }

            const result = openPositionRegular(profile, token, evaluation.live, equity, availableCash);

            if(result.opened){
                opened++;
                availableCash -= result.sizeUsd;
            }
            else{
                skipped++;
                skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;
            }

        }

    }

    const finalSummary = abTestRepository.summarize(profile, TEST_CONFIG.initial_capital);
    abTestRepository.insertEquitySnapshot(profile, finalSummary.equity);

    return { profile, opened, closed, skipped, skipReasons, equity: finalSummary.equity };

}

function runCycle(){

    const run = abTestRepository.getRun();
    if(run.status !== "RUNNING") return { skipped: true };

    const tokens = gmgnTokenRepository.getAllTokens().filter(t => t.market_cap != null && t.market_cap > 0);
    const byAddress = new Map(tokens.map(t => [t.token_address, t]));

    const momentumEngine = getMomentumHunterEngine();
    const ctx = factory.preloadContext(tokens);
    const momentumSignals = momentumEngine.analyzeTokens(tokens, ctx);
    const momentumSignalsByAddress = new Map(tokens.map((t, i) => [t.token_address, momentumSignals[i]]));

    const trenchesByAddress = gmgnTrenchesRepository.findManyByTokenAddresses(tokens.map(t => t.token_address));

    const results = PROFILES.map(profile => runCycleForProfile(profile, tokens, byAddress, momentumSignalsByAddress, trenchesByAddress));

    return { scanned: tokens.length, results };

}

module.exports = { runCycle, TEST_CONFIG, PROFILES };
