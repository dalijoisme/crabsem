// services/tradingBotEngine.js - Trading Bot Architecture Audit, Phase 9.
// CRAB Trading Bot Constitution v1.0, Final Specification section 04/08:
// this file is now a pure ORCHESTRATOR. It never scores a token itself
// and never opens/closes a position itself - those moved to
// services/tradeManager.js (Final Spec section 04). This file's only
// job per cycle: resolve which candidates exist, decide the ORDER they
// are evaluated in (Strategy Profile / Opportunity Priority / EMI -
// none of which can ever change WHICH tokens are eligible, only in what
// order eligible ones are tried while slots/cash are scarce), then hand
// each one to the SAME, unmodified evaluateEntry() gate this file has
// always used.
//
// SINGLE SOURCE OF TRUTH (Phase 8 of the audit, still true): this
// engine reads ONLY token_last_decision - the exact same record the
// Decision Timeline and the homepage's liveRecommendationService
// overlay are built from - via that SAME overlay function. If a token
// has no real decision-log entry yet, it is SKIPPED, never traded on a
// fallback guess. Production V2 itself (config/scoringConfig.js,
// services/researchEngineFactory.js) is never read, modified, or
// re-parameterized from anywhere in this file - Strategy Profile only
// ever changes trading_bot_config, never the AI Signal (Constitution
// clause 1).
//
// LIVE MODE (Sprint 2, Founder Decision - Path A): LIVE is no longer
// unconditionally refused. It is allowed for exactly one wallet - the
// configured Founder Trading Wallet (config.FOUNDER_WALLET_PUBLIC_KEY,
// enforced again independently inside gmgnSwapTransactionBuilder.js's
// own founderModeGuard.js - two layers, not one). Every other user
// requesting LIVE mode is still refused exactly as before. This is not
// a general LIVE-mode rollout.
//
// RE-ENTRY POLICY (Phase 5 of the approved strategy design): a token
// MAY be traded again after a previous close, of any outcome. What is
// gated is OVERTRADING, via a dynamic cooldown keyed to why the last
// trade closed, a decision-freshness floor, a minimum confidence floor,
// and - for re-entries specifically - a stricter bar (zero structural
// red flags) than a token's very first entry gets.

const tradingBotRepository = require("../repositories/tradingBotRepository");
const tradingWalletRepository = require("../repositories/tradingWalletRepository");
const config = require("../config/env");
const tradingBotService = require("./tradingBotService");
const tradingBotCandidateFilter = require("./tradingBotCandidateFilter");
const opportunityPriorityService = require("./opportunityPriorityService");
const emiService = require("./emiService");
const tradeManager = require("./tradeManager");
const entryGateService = require("./entryGateService");
const tradingBotCandidateSightingsRepository = require("../repositories/tradingBotCandidateSightingsRepository");
const tradingBotMissedOpportunityRepository = require("../repositories/tradingBotMissedOpportunityRepository");

// tokens/liveByAddress are computed by scheduler/tradingBotScheduler.js
// (ONCE per tick, shared across every user - see runCycle() below) and
// passed in as parameters - gmgnTokenRepository/liveRecommendationService/
// the NEUTRAL_STUB_SIGNAL stub live there now, not here.

// evaluateEntry() itself lives in entryGateService.js (Benchmark
// Harness Architecture section 3) so the live bot and the Benchmark
// Harness share the exact same 8 gate checks, never two copies. Sprint A
// Goal 2 (auth/multi-tenancy foundation): there is no more single
// default instance to bind at module load - runCycle() below builds a
// per-user createEntryGateService(tradingBotRepository.forUser(userId))
// on every call instead, the exact same factory-per-scope pattern
// services/benchmarkRunner.js already proved for benchmark participants.

// Strategy Profile / Opportunity Priority / EMI (Final Spec sections
// 02/03/04): decides the ORDER `tokens` is handed to the unmodified
// evaluateEntry() loop below - never which tokens are eligible. Exactly
// one of three mutually exclusive paths runs, in this priority:
//   1. opportunity_priority_enabled=1 (Balanced/Aggressive profile) -
//      Opportunity Priority supersedes the legacy candidateFilter
//      entirely (Final Spec section 01's resolved ambiguity).
//   2. execution_mode=HIGH_THROUGHPUT (legacy, only reachable when
//      Opportunity Priority is off) - tradingBotCandidateFilter,
//      unchanged.
//   3. neither - unchanged default order (gmgnTokenRepository.getAllTokens()'s
//      own ORDER BY market_cap DESC).
//
// Live Decision Center / Signal Center sprint: returns
// { orderedTokens, rankInfoByAddress } instead of a bare array - the
// ORDER itself is byte-identical to before in every path (same
// computation, same result array), rankInfoByAddress is purely additive:
// a Map(token_address -> {rank, priorityScore, tier, combinedRank}),
// populated only in the Opportunity Priority path (empty Map otherwise -
// an honestly-absent rank downstream, never a fabricated one). This is
// opportunityPriorityService.rank()'s own already-computed output,
// previously discarded one line after being built (kept only
// `r.token`) - same "computed then discarded" shape already fixed for
// acceleration/breakdown.
function orderCandidates(tokens, liveByAddress, botConfig){

    if(botConfig.opportunity_priority_enabled){

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

        const batchContext = opportunityPriorityService.fetchBatchContext(buyCandidates);

        // Ranking-priority fix: this cycle's own real acceleration signal
        // (computed once already, per token, by the scoring pass that
        // decided BUY/STRONG BUY in the first place - see
        // scheduler/tradingBotScheduler.js's computeLiveByAddressForPhilosophy)
        // is only ever present for a profile that sets acceleration_overrides
        // (AGGRESSIVE today). undefined for every other profile, so
        // opportunityPriorityService/emiService fall back to their existing
        // prediction_history-based factors unchanged - BALANCED's ordering
        // is untouched by this.
        const accelerationByAddress = new Map(
            buyCandidates.map(t => [t.token_address, liveByAddress.get(t.token_address)?.acceleration])
        );

        const emiFlags = botConfig.emi_enabled
            ? emiService.classifyMany(buyCandidates, batchContext, accelerationByAddress)
            : null;

        const ranked = opportunityPriorityService.rank(buyCandidates, batchContext, emiFlags, accelerationByAddress);

        const rankInfoByAddress = new Map(
            ranked.map((r, i) => [r.token.token_address, {
                rank: i, priorityScore: r.priorityScore, tier: r.tier, combinedRank: r.combinedRank
            }])
        );

        // Non-BUY tokens are appended, unordered relative to each other -
        // they will all be skipped in the loop below regardless of
        // position (evaluateEntry rejects them on action tier), so their
        // relative order has no observable effect. Kept in the list so
        // skipReasons tallying below is unchanged from before this
        // milestone.
        return { orderedTokens: [...ranked.map(r => r.token), ...rest], rankInfoByAddress };

    }

    if(botConfig.execution_mode === "HIGH_THROUGHPUT"){
        return { orderedTokens: tradingBotCandidateFilter.rankCandidates(tokens), rankInfoByAddress: new Map() };
    }

    return { orderedTokens: tokens, rankInfoByAddress: new Map() };

}

// Builds the liveOptions object services/tradeManager.js's real
// execution path needs, ONLY for the configured Founder Trading Wallet -
// every other wallet requesting LIVE mode is refused before this is
// ever called. Returns null (never partially-populated) if the wallet
// doesn't match or hasn't been generated yet.
function buildLiveExecutionOptions(userId){

    const tradingWallet = tradingWalletRepository.findByUserId(userId);

    const isFounderWallet = Boolean(
        tradingWallet &&
        config.FOUNDER_WALLET_PUBLIC_KEY &&
        tradingWallet.public_key === config.FOUNDER_WALLET_PUBLIC_KEY
    );

    if(!isFounderWallet) return null;

    // Required lazily, not at module load - services/execution/index.js
    // fails closed (inert, never throws at require time) when GMGN/RPC
    // aren't configured, matching the same convention every other
    // execution-layer entry point already uses.
    const { executionService, balanceService, gmgnClient } = require("./execution");
    const { convertUsdPositionToLamports } = require("./execution/usdToSolConverter");

    return {
        executionService,
        balanceService,
        userId,
        walletPublicKey: tradingWallet.public_key,
        convertUsdToLamports: (usdAmount) => convertUsdPositionToLamports(gmgnClient, tradingWallet.public_key, usdAmount)
    };

}

// Sprint A, Goal 2 (auth/multi-tenancy foundation): tokens/liveByAddress
// are now PARAMETERS instead of recomputed inside this function - that
// computation is identical for every user (the "house profile" decision,
// see services/predictionValidationService.js), so
// scheduler/tradingBotScheduler.js computes it ONCE per tick and fans it
// out to every running user's cycle, instead of once per user per tick -
// the same "compute once, fan out" principle services/benchmarkRunner.js
// already proves. orderCandidates() itself still runs per-user below,
// since Opportunity Priority/EMI ordering genuinely depends on THIS
// user's own botConfig.
//
// ASYNC (Sprint 2): real execution is real network I/O. Every existing
// caller (scheduler/tradingBotScheduler.js) already treats this as
// fire-and-forget per user, so making it async changes nothing about
// how ticks are paced - see that file's own runUserCycle().
async function runCycle(userId, tokens, liveByAddress){

    const state = tradingBotRepository.getState(userId);

    if(state.status !== "RUNNING") return { skipped: true, reason: "NOT_RUNNING" };

    let liveOptions = null;

    if(state.mode !== "SIMULATION"){

        liveOptions = buildLiveExecutionOptions(userId);

        if(!liveOptions){
            tradingBotRepository.insertLog(userId, { logType: "ERROR", message: "LIVE mode requested but this wallet is not the configured Founder Trading Wallet - refusing to run. Staying in SIMULATION." });
            return { skipped: true, reason: "LIVE_MODE_NOT_AUTHORIZED" };
        }

    }

    const botConfig = tradingBotRepository.getConfig(userId);
    const byAddress = new Map(tokens.map(t => [t.token_address, t]));

    const { orderedTokens, rankInfoByAddress } = orderCandidates(tokens, liveByAddress, botConfig);

    // Per-user gate/manager, bound to THIS user's own scoped repository -
    // the exact same forParticipant()-style seam
    // repositories/benchmarkPositionRepository.js already proved for the
    // Benchmark Harness, now reused here via
    // repositories/tradingBotRepository.js's own forUser().
    const repositoryForUser = tradingBotRepository.forUser(userId);
    const tradeManagerForUser = tradeManager.createTradeManager(repositoryForUser, liveOptions);
    const entryGateForUser = entryGateService.createEntryGateService(repositoryForUser);

    let scanned = orderedTokens.length;
    let opened = 0, closed = 0, skipped = 0;
    const skipReasons = {};

    // ---- 1. manage OPEN positions first (exit checks use live current price) ----
    const openPositions = tradingBotRepository.findOpenPositions(userId);
    for(const position of openPositions){
        const token = byAddress.get(position.token_address);
        if(!token) continue; // token no longer tracked at all - leave position, next cycle may see it again
        const result = await tradeManagerForUser.closeIfDue(position, token, botConfig);
        if(result.closed) closed++;
    }

    // ---- 2. look for new entries ----
    let openCount = tradingBotRepository.countOpenPositions(userId);
    const portfolio = tradingBotService.getPortfolio(userId);
    let availableCash = portfolio.availableCash;

    // Momentum Validation System sprint (Self-Comparison): this cycle's
    // own real ranked BUY-tier list - already fully computed by
    // orderCandidates/rankInfoByAddress above, captured once here so any
    // BUY made below can record its real siblings (who else was ranked,
    // same cycle) without re-deriving anything. Purely observational -
    // never read back into ranking/scoring, only ever serialized onto a
    // position for later display.
    const buyTierCandidates = orderedTokens.filter(t => rankInfoByAddress.has(t.token_address));

    // Phase 2 (Live Validation & Bottleneck Elimination): real, data-backed
    // "Ranking Rejected" - a ranked BUY-tier candidate that never even got
    // a turn because a higher-ranked one already consumed the last open
    // slot/cash this cycle. Tracked here (never touching WHICH tokens are
    // eligible or their order) so it can be recorded once, after the loop,
    // for whichever real candidates were never reached.
    const visitedTokenAddresses = new Set();
    let breakReason = null;

    for(const token of orderedTokens){

        if(openCount >= botConfig.max_open_positions){ breakReason = "SLOT_FULL_BEFORE_TURN"; break; }
        if(availableCash < botConfig.min_order_size){ breakReason = "CASH_EXHAUSTED_BEFORE_TURN"; break; }

        visitedTokenAddresses.add(token.token_address);

        const live = liveByAddress.get(token.token_address);
        // Live Decision Center / Signal Center sprint: this cycle's own
        // real rank (from orderCandidates' rankInfoByAddress, above) -
        // attached onto the SAME `live` object entryGateService passes
        // through unmodified as `evaluation.live`, same pattern
        // breakdown/acceleration already use. undefined (never a
        // fabricated 0) when Opportunity Priority is off this cycle.
        const rankInfo = rankInfoByAddress.get(token.token_address);
        if(rankInfo){
            live.rankAtEntry = rankInfo.rank;
            live.priorityScoreAtEntry = rankInfo.priorityScore;
            // Momentum Validation System sprint: real "how long has CRAB
            // been eyeing this token" history - bounded to the same small
            // real BUY-tier set rankInfo already gates on, never the
            // full scan universe.
            tradingBotCandidateSightingsRepository.recordSighting(userId, {
                tokenAddress: token.token_address, tokenSymbol: token.symbol, entryPrice: token.price
            });
        }
        const evaluation = entryGateForUser.evaluateEntry(token, live, botConfig, openCount);

        if(!evaluation.eligible){
            skipped++;
            skipReasons[evaluation.reason] = (skipReasons[evaluation.reason] || 0) + 1;
            // Missed Opportunity sprint priority: only for tokens that
            // genuinely cleared the BUY/STRONG BUY action tier (rankInfo
            // truthy) - never for NOT_A_BUY_TIER_*/HARD_EXCLUDED_*/
            // NO_ENGINE_DECISION_YET rejections, which would otherwise
            // make this table grow by the full scan size instead of the
            // small real qualified-candidate count.
            if(rankInfo){
                tradingBotMissedOpportunityRepository.upsertPending(userId, {
                    tokenAddress: token.token_address, tokenSymbol: token.symbol,
                    rankAtSkip: rankInfo.rank, priorityScoreAtSkip: rankInfo.priorityScore,
                    reason: evaluation.reason, priceAtSkip: token.price
                });
            }
            continue;
        }

        if(rankInfo){
            live.siblings = buyTierCandidates
                .filter(t => t.token_address !== token.token_address)
                .map(t => ({
                    tokenAddress: t.token_address, tokenSymbol: t.symbol,
                    rank: rankInfoByAddress.get(t.token_address).rank,
                    priorityScore: rankInfoByAddress.get(t.token_address).priorityScore
                }));
        }

        const result = await tradeManagerForUser.openPosition(token, evaluation.live, botConfig, availableCash);

        if(result.opened){
            opened++;
            openCount++;
            availableCash -= result.sizeUsd;
        }
        else{
            skipped++;
            skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;
            // Phase 2: openPosition's own post-eligibility failures
            // (cash/price/risk-bands/execution) were never persisted
            // before - only entryGateService's rejections were. Same
            // real rank already in scope, same bounded gate (rankInfo
            // truthy - this token already cleared the BUY/STRONG BUY tier).
            if(rankInfo){
                tradingBotMissedOpportunityRepository.upsertPending(userId, {
                    tokenAddress: token.token_address, tokenSymbol: token.symbol,
                    rankAtSkip: rankInfo.rank, priorityScoreAtSkip: rankInfo.priorityScore,
                    reason: result.reason, priceAtSkip: token.price
                });
            }
        }

    }

    // Phase 2: any real ranked BUY-tier candidate the loop above never
    // even reached (it broke on slot/cash exhaustion first) - the real,
    // data-backed "Ranking Rejected" case. Never a fabricated reason -
    // only recorded when the loop genuinely broke early, and only for
    // candidates genuinely never visited this cycle.
    if(breakReason){
        for(const token of buyTierCandidates){
            if(visitedTokenAddresses.has(token.token_address)) continue;
            const rankInfo = rankInfoByAddress.get(token.token_address);
            tradingBotMissedOpportunityRepository.upsertPending(userId, {
                tokenAddress: token.token_address, tokenSymbol: token.symbol,
                rankAtSkip: rankInfo.rank, priorityScoreAtSkip: rankInfo.priorityScore,
                reason: breakReason, priceAtSkip: token.price
            });
        }
    }

    // Equity snapshot at the END of the cycle (after this cycle's own
    // opens/closes), same convention as services/abTestEngine.js's own
    // insertEquitySnapshot call - a fresh recompute, not the stale
    // portfolio value read at the top of this cycle (Sprint A Goal 1:
    // the real equity curve tradingBotService.getPortfolio()'s
    // maxDrawdownPct depends on).
    //
    // Phase 2 (System Throughput): openCount/availableCash are this
    // exact cycle's own final real values (already tracked through the
    // buy loop above) - carried onto the same snapshot row so Average
    // Simultaneous Position / Average Idle Cash need no second query.
    tradingBotRepository.insertEquitySnapshot(userId, tradingBotService.getPortfolio(userId).equity, openCount, availableCash);

    // Live Decision Center sprint: a bounded snapshot of what THIS cycle
    // actually saw - liveByAddress/rankInfoByAddress are both real,
    // already-computed per-token decisions that otherwise vanish the
    // moment this function returns (structurally-excluded/dead-dumped
    // tokens, hasDecision:false, are skipped entirely - genuinely
    // uninteresting noise, not a real candidate). Every real BUY/STRONG
    // BUY tier token is kept (already a small, gated set - the actual
    // "qualified candidates", never the full scan universe); HOLD/AVOID
    // are further capped to a small top-N sample for visibility, ordered
    // by their own already-computed confidence (never a new score).
    // Replaces this user's entire snapshot every cycle - bounded by
    // however many rows this produces, never by `scanned`.
    const qualifiedRows = [], holdCandidates = [], avoidCandidates = [];
    for(const token of tokens){
        const live = liveByAddress.get(token.token_address);
        if(!live || !live.hasDecision) continue;
        const rankInfo = rankInfoByAddress.get(token.token_address);
        const row = {
            tokenAddress: token.token_address, tokenSymbol: token.symbol,
            action: live.action, confidence: live.confidence, risk: live.risk,
            tier: rankInfo?.tier ?? null, rank: rankInfo?.rank ?? null, priorityScore: rankInfo?.priorityScore ?? null,
            reasons: live.reasons?.length ? live.reasons : (live.exclusionReason ? [live.exclusionReason] : [])
        };
        if(live.action === "BUY" || live.action === "STRONG BUY") qualifiedRows.push(row);
        else if(live.action === "HOLD") holdCandidates.push(row);
        else avoidCandidates.push(row);
    }
    holdCandidates.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const waitRows = holdCandidates.slice(0, 20);
    const avoidRows = avoidCandidates.slice(0, 5);
    tradingBotRepository.replaceDecisionSnapshot(userId, [...qualifiedRows, ...waitRows, ...avoidRows]);

    // Trust/UX sprint: the scheduler already console.log's this exact
    // summary server-side (scheduler/tradingBotScheduler.js) - nothing
    // before this ever reached the dashboard's own Activity Log, so
    // Scanner/Filtering/Ranking/Monitor were invisible to the user
    // entirely. One row per cycle, not one per scanned token - bounded
    // by TIME (~5,760/day at a 15s interval), never by the ~12,000-token
    // scan size, which is what a per-token log would cost instead.
    tradingBotRepository.insertLog(userId, {
        logType: "SYSTEM",
        message: `Cycle complete: scanned ${scanned}, opened ${opened}, closed ${closed}, skipped ${skipped}.`,
        meta: { scanned, opened, closed, skipped, skipReasons }
    });

    // Live Decision Center sprint: two more real, per-cycle SYSTEM rows -
    // Filtering and Ranking - still bounded by cycle count (not token
    // count), same convention as the cycle-summary row above. Both
    // derived purely from data already computed above in this same
    // cycle, never a new computation.
    tradingBotRepository.insertLog(userId, {
        logType: "SYSTEM",
        message: `Filtering: ${qualifiedRows.length} qualified (BUY/STRONG BUY) of ${scanned} scanned.`,
        meta: { qualifiedCount: qualifiedRows.length, holdCount: holdCandidates.length, avoidCount: avoidCandidates.length, scanned }
    });

    const topCandidate = qualifiedRows.find(r => (rankInfoByAddress.get(r.tokenAddress)?.rank ?? null) === 0);
    tradingBotRepository.insertLog(userId, {
        logType: "SYSTEM",
        message: topCandidate
            ? `Ranking: top candidate is ${topCandidate.tokenSymbol || topCandidate.tokenAddress.slice(0, 8)} at rank #1 (priority ${topCandidate.priorityScore}).`
            : "Ranking: no ranked BUY-tier candidate this cycle.",
        meta: { topCandidate: topCandidate ? { tokenAddress: topCandidate.tokenAddress, tokenSymbol: topCandidate.tokenSymbol, priorityScore: topCandidate.priorityScore } : null }
    });

    return { scanned, opened, closed, skipped, skipReasons };

}

// orderCandidates is exported alongside runCycle purely for the Final
// Spec section 18 regression test (tradingBotEngine.test.js) - a pure
// function, unaffected by the multi-tenancy refactor above, no other
// module in this codebase calls it directly.
//
// buildLiveExecutionOptions is exported for tradingBotService.js's
// forceSellAll()/sellPosition() (Trust/UX sprint) - a user-triggered
// manual sell needs the exact same Founder-Wallet-gated liveOptions
// bundle this file's own runCycle() already builds, never a second
// construction of it. Required lazily from tradingBotService.js (not a
// top-level require there) since this file already requires
// tradingBotService.js itself - a top-level require in the other
// direction would be circular.
module.exports = { runCycle, orderCandidates, buildLiveExecutionOptions };
