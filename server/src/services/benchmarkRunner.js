// services/benchmarkRunner.js - Benchmark Harness Architecture Design
// Document, section 2 (Data Flow) and section 5 (Runner). Pure per-
// cycle orchestration: fetch every shared, single-source-of-truth input
// EXACTLY ONCE, then fan out in-memory to every participant using the
// SAME reused entryGateService/tradeManager logic each participant in
// trading_bot_config already uses - never a second implementation of
// the gate or the position lifecycle.
//
// UPDATED (Profile-Aware Production V2 refactor, approved architecture:
// C:\Users\HARY\.claude\plans\floating-sauteeing-swan.md): scoring
// itself is now profile-distinct - Production V2's already-generic
// philosophy-override mechanism (researchEngineFactory.js) is called
// ONCE PER DISTINCT PROFILE among this run's participants (dedup'd by
// translated-philosophy signature - two participants sharing an
// identical profile still score once), not once globally. This is the
// direct fix for "every profile saw the same candidates" - see
// computeProfileSignals() below. Production V2 itself stays ONE
// implementation; this file calls it with different parameters, never
// a second engine and never scoringConfig.js edits.
//
// SHARED (computed once PER DISTINCT PROFILE per tick, not once
// globally, not once per participant):
//   - Production V2 scoring pass (computeProfileSignals)
//   - Opportunity Priority batch context + ranking, grouped by
//     (profileKey, opportunity_priority_enabled, emi_enabled)
//   - EMI classification, same grouping
//
// ISOLATED (per participant, in-memory fan-out, no shared state):
//   - gate evaluation, position open/close, cash/openCount bookkeeping -
//     each via entryGateService/tradeManager bound to that participant's
//     OWN scoped repository (repositories/benchmarkPositionRepository.js's
//     forParticipant()), and now also each participant's OWN translated
//     philosophy/qualityGateOverrides/exitOverrides.
//
// Constitution: never writes to scoringConfig.js (the true hard-reject/
// structural-validation block stays global, untouched by any profile),
// never touches trading_bot_config - purely an observer/evaluator of
// the same real Production V2 the live bot reads, just parameterized.

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const benchmarkRunRepository = require("../repositories/benchmarkRunRepository");
const benchmarkPositionRepository = require("../repositories/benchmarkPositionRepository");
const liveRecommendationService = require("./liveRecommendationService");
const opportunityPriorityService = require("./opportunityPriorityService");
const emiService = require("./emiService");
const productionEngineResolver = require("./productionEngineResolver");
const scoringWorkerPool = require("./scoringWorkerPool");
const strategyProfileTranslator = require("./strategyProfileTranslator");
const benchmarkFunnelRepository = require("../repositories/benchmarkFunnelRepository");
const benchmarkCandidateSightingsRepository = require("../repositories/benchmarkCandidateSightingsRepository");
const { createTradeManager } = require("./tradeManager");
const { createEntryGateService } = require("./entryGateService");

const NEUTRAL_STUB_SIGNAL = { action: "HOLD", confidence: 0, risk: "HIGH" };

function nowSqlite(){
    return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// Execution-cost realism assumptions shared by EVERY participant in
// EVERY run, deliberately not part of benchmark_profiles.config_json -
// the Benchmark Harness compares STRATEGY differences (confidence,
// sizing, Opportunity Priority, EMI); execution conditions (fees,
// slippage, minimum order size, one-position-per-token) must stay
// identical across participants for the comparison to be fair, matching
// the architecture's own OBJECTIVE section. Same real values
// trading_bot_config has always defaulted to.
const SHARED_EXECUTION_DEFAULTS = {
    min_order_size: 10,
    fee_pct: 1,
    slippage_pct: 1,
    one_position_per_token: 1
};

// profileKey: a deterministic signature of exactly the fields that
// affect SCORING (philosophy + qualityGateOverrides) - two participants
// that translate to the identical signature are the same "distinct
// profile" for computeProfileSignals()'s dedup, even if their non-
// scoring config (position sizing, cooldowns, etc.) differs.
function profileKeyFor(engineParams){
    return JSON.stringify({ p: engineParams.philosophy, q: engineParams.qualityGateOverrides });
}

function parseParticipants(runId){
    return benchmarkRunRepository.findParticipantsByRun(runId).map(p => {
        const rawConfig = { ...SHARED_EXECUTION_DEFAULTS, ...JSON.parse(p.frozen_config_json) };
        const engineParams = strategyProfileTranslator.translate(rawConfig);
        return {
            ...p,
            config: {
                ...rawConfig,
                philosophy: engineParams.philosophy,
                qualityGateOverrides: engineParams.qualityGateOverrides,
                exitOverrides: engineParams.exitOverrides,
                momentumWeakeningBuyerDominanceRatio: engineParams.exitOverrides.momentumWeakeningBuyerDominanceRatio
            },
            engineParams,
            profileKey: profileKeyFor(engineParams)
        };
    });
}

// Computes each DISTINCT profile's scored signal map exactly once per
// tick, regardless of participant count (core mechanism of the
// Profile-Aware Production V2 refactor - see file header). Builds an
// in-memory, "live-shaped" object per token per distinct profile,
// bypassing liveRecommendationService/token_last_decision entirely for
// this path - that table can only ever hold ONE profile's answer, so
// it structurally cannot represent N simultaneous profile views.
// Structural exclusion (dead/dumped status) is still applied and is
// identical across every profile, matching the Constitution's Hard
// Reject requirement; Quality Gate is NOT applied here - it's a soft,
// profile-tunable filter checked downstream, per-profile, by
// entryGateService.evaluateEntry() (see qualityGateOverrides).
async function computeProfileSignals(tokens, participants){

    const activeVersion = productionEngineResolver.getActiveVersion();

    if(activeVersion !== "production_v2"){
        // Graceful degrade: the legacy engine has no philosophy-override
        // mechanism at all - fall back to one shared, profile-blind map
        // (today's pre-refactor behavior) rather than fail the tick.
        // Never silently pretend V1 supports profile-aware scoring.
        console.warn(`[benchmarkRunner] active engine is '${activeVersion}', not 'production_v2' - profile-aware scoring is unavailable this tick, falling back to one shared signal map for every participant.`);
        const shared = new Map(tokens.map(t => [t.token_address, liveRecommendationService.resolveLiveRecommendation(t, NEUTRAL_STUB_SIGNAL)]));
        const funnel = { tokensScanned: tokens.length, hardRejectCount: null, aiCandidatesCount: null, aiTierPassedCount: null, profileAware: false };
        const sharedBuyTierTokens = tokens
            .filter(t => { const live = shared.get(t.token_address); return live.action === "BUY" || live.action === "STRONG BUY"; })
            .map(t => ({ tokenAddress: t.token_address, entryPrice: Number(t.price) || null }));
        return {
            byParticipantId: new Map(participants.map(p => [p.id, shared])),
            funnelByParticipantId: new Map(participants.map(p => [p.id, funnel])),
            buyTierTokensByParticipantId: new Map(participants.map(p => [p.id, sharedBuyTierTokens]))
        };
    }

    const nowStamp = nowSqlite();
    const byProfileKey = new Map();

    for(const participant of participants){

        if(byProfileKey.has(participant.profileKey)) continue;

        // Root Cause Analysis fix: this used to be a direct, synchronous
        // activeEngine.analyzeTokens(...) call - the exact multi-second,
        // zero-yield-point call proven to starve the event loop (and with
        // it the live GMGN collector) for its entire duration. Routed
        // through scoringWorkerPool so the heavy scoring pass runs on a
        // separate thread instead of blocking this one. Still ONE call
        // per distinct profile, sequential is fine here - there is only
        // one persistent worker (not a pool), so parallelizing these
        // awaits wouldn't parallelize the actual work anyway.
        const signals = await scoringWorkerPool.scoreTokens(tokens, participant.engineParams.philosophy);

        const liveMap = new Map();
        // Collected once per distinct profile (not per participant) -
        // reused by tick() to record benchmark_candidate_sightings for
        // every participant that shares this profile, without a second
        // 9300-token scan per participant.
        const buyTierTokens = [];
        let hardRejectCount = 0, aiTierPassedCount = 0;

        for(let i = 0; i < tokens.length; i++){

            const token = tokens[i];
            const structural = liveRecommendationService.computeStructuralExclusion(token);

            if(structural.excluded){
                hardRejectCount++; // structural exclusion counts as "Hard Reject" in the funnel too
                liveMap.set(token.token_address, {
                    action: "AVOID", confidence: 0, risk: "HIGH",
                    excludeFromTrending: true, exclusionReason: structural.reason,
                    hasDecision: false, decayFraction: 0, tokenStatus: structural.tokenStatus
                });
                continue;
            }

            const signal = signals[i];
            if(signal.action === "AVOID") hardRejectCount++;
            if(signal.action === "BUY" || signal.action === "STRONG BUY"){
                aiTierPassedCount++;
                buyTierTokens.push({ tokenAddress: token.token_address, entryPrice: Number(token.price) || null });
            }

            liveMap.set(token.token_address, {
                action: signal.action, confidence: signal.confidence, risk: signal.risk,
                excludeFromTrending: false, exclusionReason: null,
                hasDecision: true, decayFraction: 1, lastDecisionAt: nowStamp,
                participantScore: signal.participantScore, marketHealth: signal.marketHealth
            });

        }

        byProfileKey.set(participant.profileKey, {
            liveMap, buyTierTokens,
            funnel: {
                tokensScanned: tokens.length, hardRejectCount,
                aiCandidatesCount: tokens.length - hardRejectCount,
                aiTierPassedCount, profileAware: true
            }
        });

    }

    const byParticipantId = new Map();
    const funnelByParticipantId = new Map();
    const buyTierTokensByParticipantId = new Map();
    for(const participant of participants){
        const entry = byProfileKey.get(participant.profileKey);
        byParticipantId.set(participant.id, entry.liveMap);
        funnelByParticipantId.set(participant.id, entry.funnel);
        buyTierTokensByParticipantId.set(participant.id, entry.buyTierTokens || []);
    }

    return { byParticipantId, funnelByParticipantId, buyTierTokensByParticipantId };

}

// Runs Opportunity Priority/EMI at most twice total (once without EMI,
// once with) regardless of how many participants need them - see file
// header. Returns { withoutEmi, withEmi } - either may be null if no
// participant needs that combination this tick.
function computeSharedOrderings(tokens, liveByAddress, participants){

    const anyOpportunityPriority = participants.some(p => p.config.opportunity_priority_enabled);
    if(!anyOpportunityPriority) return { withoutEmi: null, withEmi: null };

    const buyAddresses = new Set();
    const buyCandidates = [];
    const rest = [];

    for(const token of tokens){
        const live = liveByAddress.get(token.token_address);
        if(live.action === "BUY" || live.action === "STRONG BUY"){
            buyAddresses.add(token.token_address);
            buyCandidates.push(token);
        }
        else{
            rest.push(token);
        }
    }

    const batchContext = opportunityPriorityService.fetchBatchContext(buyCandidates); // ONCE

    const anyEmi = participants.some(p => p.config.opportunity_priority_enabled && p.config.emi_enabled);
    const emiFlags = anyEmi ? emiService.classifyMany(buyCandidates, batchContext) : null; // ONCE

    const withoutEmi = [
        ...opportunityPriorityService.rank(buyCandidates, batchContext).map(r => r.token),
        ...rest
    ];

    const withEmi = anyEmi
        ? [...opportunityPriorityService.rank(buyCandidates, batchContext, emiFlags).map(r => r.token), ...rest]
        : null;

    return { withoutEmi, withEmi };

}

function orderForParticipant(config, tokens, sharedOrderings){
    if(!config.opportunity_priority_enabled) return tokens;
    return config.emi_enabled ? sharedOrderings.withEmi : sharedOrderings.withoutEmi;
}

function runParticipantCycle(runId, participant, tokens, byAddress, liveByAddress, orderedTokens){

    const config = participant.config;
    const repository = benchmarkPositionRepository.forParticipant(runId, participant.id);
    const tradeManager = createTradeManager(repository);
    const entryGate = createEntryGateService(repository);

    let opened = 0, closed = 0, skipped = 0;
    const skipReasons = {};

    // ---- 1. manage OPEN positions first, same order as tradingBotEngine.runCycle ----
    const openPositions = benchmarkPositionRepository.findOpenPositions(participant.id);
    for(const position of openPositions){
        const token = byAddress.get(position.token_address);
        if(!token) continue;
        const result = tradeManager.closeIfDue(position, token, config);
        if(result.closed) closed++;
    }

    // ---- 2. look for new entries ----
    let openCount = benchmarkPositionRepository.countOpenPositions(participant.id);
    const closedSums = benchmarkPositionRepository.sumClosedTrades(participant.id);
    const openSums = benchmarkPositionRepository.sumOpenPositions(participant.id);
    let availableCash = participant.initial_capital + closedSums.realizedPnl - openSums.openValueAtEntry;

    for(const token of orderedTokens){

        if(openCount >= config.max_open_positions) break;
        if(availableCash < config.min_order_size) break;

        const live = liveByAddress.get(token.token_address);
        const evaluation = entryGate.evaluateEntry(token, live, config, openCount);

        if(!evaluation.eligible){
            skipped++;
            skipReasons[evaluation.reason] = (skipReasons[evaluation.reason] || 0) + 1;
            continue;
        }

        const result = tradeManager.openPosition(token, evaluation.live, config, availableCash);

        if(result.opened){
            opened++;
            openCount++;
            availableCash -= result.sizeUsd;
            // Signal Latency source (report section 7) - written once,
            // right after open, never reconstructed from logs later.
            benchmarkPositionRepository.setDecisionAt(result.positionId, evaluation.live.lastDecisionAt ?? null);
        }
        else{
            skipped++;
            skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;
        }

    }

    return {
        runParticipantId: participant.id,
        profileName: participant.profile_name,
        initialCapital: participant.initial_capital,
        opened, closed, skipped, skipReasons
    };

}

// One cycle for one run. Production V2 scoring is fetched exactly once
// PER DISTINCT PROFILE above this point (computeProfileSignals);
// Opportunity Priority ranking is fetched exactly once per distinct
// (profileKey, opportunity_priority_enabled, emi_enabled) group;
// runParticipantCycle() below is a pure in-memory fan-out over
// already-computed data - same "compute once, fan out" principle as
// before this refactor, just scoped to distinct profile groups instead
// of the whole tick.
async function tick(runId){

    const participants = parseParticipants(runId);
    if(!participants.length) return { runId, scanned: 0, participantResults: [] };

    const tokens = gmgnTokenRepository.getAllTokens().filter(t => t.market_cap != null && t.market_cap > 0);
    const byAddress = new Map(tokens.map(t => [t.token_address, t]));

    // Profile-Aware Production V2 refactor: replaces the old single
    // shared liveByAddress map (which is WHY every profile used to see
    // the same candidates) with one map per distinct profile.
    const { byParticipantId, funnelByParticipantId, buyTierTokensByParticipantId } = await computeProfileSignals(tokens, participants);

    const orderingsByGroupKey = new Map();

    const participantResults = participants.map(participant => {

        const liveByAddress = byParticipantId.get(participant.id);
        const groupKey = `${participant.profileKey}|${participant.config.opportunity_priority_enabled ? 1 : 0}|${participant.config.emi_enabled ? 1 : 0}`;

        if(!orderingsByGroupKey.has(groupKey)){
            const sameGroupParticipants = participants.filter(p =>
                p.profileKey === participant.profileKey &&
                Boolean(p.config.opportunity_priority_enabled) === Boolean(participant.config.opportunity_priority_enabled) &&
                Boolean(p.config.emi_enabled) === Boolean(participant.config.emi_enabled)
            );
            orderingsByGroupKey.set(groupKey, computeSharedOrderings(tokens, liveByAddress, sameGroupParticipants));
        }

        const sharedOrderings = orderingsByGroupKey.get(groupKey);
        const orderedTokens = orderForParticipant(participant.config, tokens, sharedOrderings);
        const result = runParticipantCycle(runId, participant, tokens, byAddress, liveByAddress, orderedTokens);

        // Funnel visibility (architecture requirement): one snapshot row
        // per participant per tick, plus this participant's own
        // profile-scored BUY-tier candidates recorded for the hindsight
        // metrics fix (see benchmarkReportService.js).
        const funnel = funnelByParticipantId.get(participant.id);
        benchmarkFunnelRepository.insertSnapshot({
            runId, runParticipantId: participant.id,
            tokensScanned: funnel.tokensScanned, hardRejectCount: funnel.hardRejectCount,
            aiCandidatesCount: funnel.aiCandidatesCount, aiTierPassedCount: funnel.aiTierPassedCount,
            entryGateOpenedCount: result.opened, entryGateSkippedCount: result.skipped,
            skipReasons: result.skipReasons, profileAware: funnel.profileAware
        });

        for(const candidate of buyTierTokensByParticipantId.get(participant.id) || []){
            benchmarkCandidateSightingsRepository.recordSighting({
                runId, runParticipantId: participant.id,
                tokenAddress: candidate.tokenAddress, entryPrice: candidate.entryPrice
            });
        }

        return { ...result, funnel };

    });

    return { runId, scanned: tokens.length, participantResults };

}

module.exports = { tick, SHARED_EXECUTION_DEFAULTS };
