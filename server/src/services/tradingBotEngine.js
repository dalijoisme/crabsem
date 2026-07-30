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

        const emiFlags = botConfig.emi_enabled
            ? emiService.classifyMany(buyCandidates, batchContext)
            : null;

        const ranked = opportunityPriorityService.rank(buyCandidates, batchContext, emiFlags);

        // Non-BUY tokens are appended, unordered relative to each other -
        // they will all be skipped in the loop below regardless of
        // position (evaluateEntry rejects them on action tier), so their
        // relative order has no observable effect. Kept in the list so
        // skipReasons tallying below is unchanged from before this
        // milestone.
        return [...ranked.map(r => r.token), ...rest];

    }

    if(botConfig.execution_mode === "HIGH_THROUGHPUT"){
        return tradingBotCandidateFilter.rankCandidates(tokens);
    }

    return tokens;

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

    const orderedTokens = orderCandidates(tokens, liveByAddress, botConfig);

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

    for(const token of orderedTokens){

        if(openCount >= botConfig.max_open_positions) break;
        if(availableCash < botConfig.min_order_size) break;

        const live = liveByAddress.get(token.token_address);
        const evaluation = entryGateForUser.evaluateEntry(token, live, botConfig, openCount);

        if(!evaluation.eligible){
            skipped++;
            skipReasons[evaluation.reason] = (skipReasons[evaluation.reason] || 0) + 1;
            continue;
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
        }

    }

    // Equity snapshot at the END of the cycle (after this cycle's own
    // opens/closes), same convention as services/abTestEngine.js's own
    // insertEquitySnapshot call - a fresh recompute, not the stale
    // portfolio value read at the top of this cycle (Sprint A Goal 1:
    // the real equity curve tradingBotService.getPortfolio()'s
    // maxDrawdownPct depends on).
    tradingBotRepository.insertEquitySnapshot(userId, tradingBotService.getPortfolio(userId).equity);

    return { scanned, opened, closed, skipped, skipReasons };

}

// orderCandidates is exported alongside runCycle purely for the Final
// Spec section 18 regression test (tradingBotEngine.test.js) - a pure
// function, unaffected by the multi-tenancy refactor above, no other
// module in this codebase calls it directly.
module.exports = { runCycle, orderCandidates };
