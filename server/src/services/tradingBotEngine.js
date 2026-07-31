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
const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const tradingWalletRepository = require("../repositories/tradingWalletRepository");
const config = require("../config/env");
const tradingBotService = require("./tradingBotService");
const tradingBotCandidateFilter = require("./tradingBotCandidateFilter");
const opportunityPriorityService = require("./opportunityPriorityService");
const emiService = require("./emiService");
const tradeManager = require("./tradeManager");
const entryGateService = require("./entryGateService");
const { marketAgeSecondsFor } = entryGateService;
const tradingBotCandidateSightingsRepository = require("../repositories/tradingBotCandidateSightingsRepository");
const tradingBotMissedOpportunityRepository = require("../repositories/tradingBotMissedOpportunityRepository");
const gmgnOndemandService = require("./gmgnOndemandService");
// Section H (Candidate Card): read-only reuse of buildRiskBands for a
// real "if bought now" Target price on qualified/watch candidates -
// never used here to score/decide anything (this file still never
// scores a token itself, per its own header comment).
const productionEngineResolver = require("./productionEngineResolver");

// Production Stabilization V1, Section A (Exit Engine root cause): a
// held position's token in gmgn_tokens is only ever refreshed by
// collectors/gmgn/trendingCollector.js's top-100-per-interval trending
// merge - a token that stops appearing in GMGN's own trending rankings
// (exactly what a token that just crashed does; trending ranks rising
// volume/momentum, never a dump) simply freezes at its last trending-
// snapshot price forever, with nothing anywhere flagging it as stale.
// Confirmed against real, live data, not hypothesized: of 5 positions
// opened in the exact same cycle, 4 whose tokens fell out of trending
// never received a single price update afterward (current_price stayed
// byte-identical to entry_price, mfe_pct/mae_pct stayed exactly 0)
// while the 5th, whose token stayed trending, tracked ROI correctly the
// whole time. Since services/dynamicExitService.js's Stop Loss/Take
// Profit/ROI all compute directly from `token.price`, a position can
// crash to near-zero and never close - not because Hard Stop Loss is
// bypassed by Dynamic Exit's own trailing logic (it isn't - the SL
// check there is already unconditional and runs before any "let it
// ride" reasoning), but because the price it evaluates against never
// moves.
//
// Fix: every OPEN position gets its own on-demand freshness check,
// independent of whether its token is still in this cycle's shared
// trending snapshot. STALE_AFTER_MS is 3x the trending collector's own
// 30s tick (scheduler/gmgnTrendingScheduler.js) - long enough that
// normal tick jitter never falsely trips it, short enough that a token
// which has genuinely stopped being tracked is caught within one or two
// bot cycles for every existing scan_interval_seconds default.
const HELD_POSITION_CHAIN = "sol";
const HELD_POSITION_STALE_AFTER_MS = 90 * 1000;

function msSinceTokenSeen(token){
    const lastSeen = token?.last_seen || token?.updated_at;
    if(!lastSeen) return Infinity;
    return Date.now() - new Date(`${String(lastSeen).replace(" ", "T")}Z`).getTime();
}

// Pure extraction - given already-fetched GMGN on-demand responses,
// returns a real fresh price (never a hand-derived AMM reserve
// calculation from token_pool_info's raw reserves - decimals/reserve-
// side are too easy to get wrong, and a wrong derived price would be a
// WORSE bug than the stale one being fixed here; token_kline's own
// `close` is GMGN's own already-computed number, same source the
// trending snapshot's own price ultimately comes from) plus a fresh
// liquidity figure (token_pool_info's real-time value - read by
// qualityGateService's rug re-check). Every other field (market_cap,
// volume, holders, price_change_5m) is deliberately left untouched from
// the last known snapshot: re-deriving Momentum Hunter's other real
// inputs outside the frozen engine is out of scope for this fix - only
// the two fields the Stop Loss/Take Profit/rug-check floor actually
// depend on are refreshed. Returns null if GMGN gave nothing real
// (never fabricates a price).
function extractFreshPriceAndLiquidity(poolResult, klineResult){
    const candles = klineResult?.data?.list;
    const latestCandle = Array.isArray(candles) && candles.length ? candles[candles.length - 1] : null;
    const freshPrice = latestCandle ? Number(latestCandle.close) : null;

    if(!freshPrice || freshPrice <= 0) return null;

    const rawLiquidity = poolResult?.data?.liquidity;
    const freshLiquidity = rawLiquidity != null ? Number(rawLiquidity) : null;

    return { price: freshPrice, liquidity: freshLiquidity };
}

// ondemandService is injectable purely for testing (same optional-
// trailing-parameter DI seam services/tradeManager.js's liveOptions
// already uses) - defaults to the real, already-built, already-cached
// GMGN on-demand client (services/gmgnOndemandService.js), never a
// second API surface. Fails soft: any GMGN error/timeout, or an empty/
// zero response, logs a real WARNING and keeps using whatever token
// data was already in hand - never crashes the cycle, never fabricates
// a price.
async function refreshStaleHeldToken(userId, position, token, ondemandService){

    try{

        const [poolResult, klineResult] = await Promise.all([
            ondemandService.getTokenPoolInfo(HELD_POSITION_CHAIN, position.token_address),
            ondemandService.getTokenKline(HELD_POSITION_CHAIN, position.token_address, "1h")
        ]);

        const fresh = extractFreshPriceAndLiquidity(poolResult, klineResult);
        if(!fresh) return token;

        return {
            ...(token || { token_address: position.token_address, symbol: position.token_symbol }),
            price: fresh.price,
            liquidity: fresh.liquidity ?? token?.liquidity ?? null,
            // Production Stabilization Final, Section B: this on-demand
            // refresh only re-verifies price/liquidity (the two Hard Stop
            // Loss/rug-check actually depend on) - price_change_5m,
            // volume_1h, and this token's trenches row are NOT re-fetched
            // here and may be hours stale, carried through unchanged from
            // whatever `token` was (or absent entirely). Flagged so
            // dynamicExitService's momentum-hold logic (the +15% "let it
            // ride while real evidence supports it" branch, never the
            // Stop Loss floor, which always uses the fresh price above)
            // never treats stale/absent momentum evidence as license to
            // keep holding.
            marketContextStale: true
        };

    }
    catch(err){

        tradingBotRepository.insertLog(userId, {
            logType: "WARNING",
            message: `Held position ${position.token_symbol} price refresh failed (${err.message}) - its token has fallen out of the trending snapshot and the on-demand refresh also failed this cycle; exit checks are using the last known price.`,
            meta: { tokenAddress: position.token_address, positionId: position.id, error: err.message }
        });

        return token;

    }

}

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
            // False Positive Reduction V2, Priority 4: a HIGH-risk candidate
            // is never ranked - entryGateService already hard-rejects it
            // outright (Production Stabilization V2), so ranking it was
            // pure noise at best - at worst, Opportunity Priority's own
            // heat-based formula (confidenceVelocity/participantScoreVelocity/
            // triggerHeat/priceVelocity/buyPressure - none of them a safety
            // signal) could and did rank a HIGH-risk token to the very top
            // (real proof: MOON, this account's own real BUY, ranked #2 of 2
            // at priority 97 while risk:"HIGH"). Routed to `rest` instead of
            // `buyCandidates` - still visited by the entry-gate loop below in
            // its original scan order (so it is still real-logged as
            // HIGH_RISK_REJECTED, same as today), just never occupies a
            // ranked leaderboard slot or a real candidate's sibling list.
            // This changes ORDER/observability only - identical to before
            // for every LOW/MEDIUM-risk candidate, and no token that was
            // ever actually bought before this change stops being eligible.
            if((live.action === "BUY" || live.action === "STRONG BUY") && live.risk !== "HIGH"){
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

        // Production Stabilization V2 (Close Remaining BUY Blind Spots,
        // Section 3 - Opportunity Ranking): the same real riskReasons
        // array entryGateService's own HIGH-risk gate already reads off
        // `live`, threaded through so ranking can de-prioritize a
        // relatively more dangerous MEDIUM/LOW-risk candidate among this
        // cycle's real BUY-tier pool - never a new signal, never a
        // second copy of it.
        const riskReasonsByAddress = new Map(
            buyCandidates.map(t => [t.token_address, liveByAddress.get(t.token_address)?.riskReasons])
        );

        const emiFlags = botConfig.emi_enabled
            ? emiService.classifyMany(buyCandidates, batchContext, accelerationByAddress)
            : null;

        const ranked = opportunityPriorityService.rank(buyCandidates, batchContext, emiFlags, accelerationByAddress, riskReasonsByAddress);

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

// Exit Evaluation Interval sprint: the exact loop body runCycle()'s own
// "manage OPEN positions first" section always ran, extracted verbatim
// so the independent, faster exit-only scheduler
// (scheduler/exitEvaluationScheduler.js's runExitCycle() below) can
// share it - never a second copy of the close-decision wiring. Preserves
// every existing Dynamic Exit behavior unmodified: dynamicExitService.js/
// tradeManager.js's closeIfDue/finalizeClose are called exactly as
// before, in the exact same order, for the exact same positions.
//
// tokensByAddress: runCycle() passes its own already-computed
// byAddress Map (this tick's shared trending snapshot - zero behavior
// change, zero extra query). The independent exit-only scheduler has no
// such tick-wide snapshot (it never scans/scores the full token
// universe - that would increase BUY-side cost for no reason) and
// passes null instead - each open position's own token is looked up
// individually via gmgnTokenRepository.getTokenByAddress(), the exact
// same gmgn_tokens table, just a targeted single-row read rather than
// an in-memory map lookup. No new RPC/network call either way - both
// paths only ever call ondemandService (ondemandService.getTokenPoolInfo/
// getTokenKline) for a position whose token is already stale, exactly as
// today.
async function manageOpenPositions(userId, tradeManagerForUser, botConfig, tokensByAddress, ondemandService){

    let closed = 0;
    const openPositions = tradingBotRepository.findOpenPositions(userId);

    for(const position of openPositions){

        let token = tokensByAddress
            ? tokensByAddress.get(position.token_address)
            : gmgnTokenRepository.getTokenByAddress(position.token_address);

        // Exit Engine root-cause fix (see refreshStaleHeldToken's own
        // header comment above) - a token that fell out of this cycle's
        // shared trending snapshot (or was never in it at all) gets its
        // own on-demand freshness check here, so a held position is
        // never evaluated against a price that stopped being real.
        if(msSinceTokenSeen(token) > HELD_POSITION_STALE_AFTER_MS){
            token = await refreshStaleHeldToken(userId, position, token, ondemandService);
        }
        if(!token) continue; // never seen even once, and the on-demand refresh also found nothing real - leave position, next cycle may resolve it

        const result = await tradeManagerForUser.closeIfDue(position, token, botConfig);
        if(result.closed) closed++;

    }

    return closed;

}

// Exit Evaluation Interval sprint: the independent exit-only cycle -
// scheduler/exitEvaluationScheduler.js calls this on each user's OWN
// trading_bot_config.exit_evaluation_interval_seconds cadence (default
// 5s), completely decoupled from scan_interval_seconds (the BUY-side
// scan/AI-scoring cadence, which this never touches). Never calls
// gmgnTokenRepository.getAllTokens(), scoringWorkerPool.scoreTokens(),
// orderCandidates(), or entryGateService - only ever reads/evaluates
// this user's own currently-OPEN positions, so BUY-side RPC/compute cost
// is completely unaffected by how often this runs.
//
// Mirrors runCycle()'s own state/liveOptions/tradeManager setup exactly
// (deliberately small, duplicated DB-only plumbing, never the Dynamic
// Exit logic itself) rather than sharing that setup code with runCycle() -
// keeps runCycle() itself completely untouched, changing nothing about
// its own proven behavior.
async function runExitCycle(userId, ondemandService = gmgnOndemandService){

    const state = tradingBotRepository.getState(userId);
    if(state.status !== "RUNNING") return { skipped: true, reason: "NOT_RUNNING" };

    let liveOptions = null;

    if(state.mode !== "SIMULATION"){
        liveOptions = buildLiveExecutionOptions(userId);
        if(!liveOptions) return { skipped: true, reason: "LIVE_MODE_NOT_AUTHORIZED" };
    }

    const botConfig = tradingBotRepository.getConfig(userId);
    const repositoryForUser = tradingBotRepository.forUser(userId);
    const tradeManagerForUser = tradeManager.createTradeManager(repositoryForUser, liveOptions);

    const closed = await manageOpenPositions(userId, tradeManagerForUser, botConfig, null, ondemandService);

    return { skipped: false, closed };

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
async function runCycle(userId, tokens, liveByAddress, ondemandService = gmgnOndemandService){

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
    // Exit Evaluation Interval sprint: this loop body now lives in
    // manageOpenPositions() below, shared with the independent, faster
    // exit-only scheduler (scheduler/exitEvaluationScheduler.js's
    // runExitCycle()) - same variables, same call, same order as before
    // this extraction, so this cycle's own behavior is unchanged.
    closed = await manageOpenPositions(userId, tradeManagerForUser, botConfig, byAddress, ondemandService);

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
            // Production Hotfix V1.1, Section 3: a stale-data rejection
            // must never be silent - a real, human-readable log row every
            // time, not just a DB stat for later. Matches the sprint's
            // own required message shape exactly.
            if(evaluation.reason === "STALE_MARKET_DATA"){
                const ageLabel = evaluation.marketAgeSeconds != null ? Math.round(evaluation.marketAgeSeconds) : "unknown";
                // STALE_MARKET_DATA root-cause observability: the age
                // alone can't tell "the collector never refreshed this
                // token at all" apart from "the collector is healthy,
                // this token just fell out of its own source coverage" -
                // both raw inputs entryGateService.js's marketAgeSecondsFor
                // actually diffs (token.updated_at, falling back to
                // last_seen) plus the evaluation instant itself are
                // captured here, never re-derived differently. Printed to
                // the server console for real-time visibility while
                // tailing logs, AND persisted in this same WARNING row's
                // meta_json for later querying (trading_bot_log) - one
                // fact, two destinations, never a second computation.
                const lastTimestamp = token.updated_at || token.last_seen || null;
                const evaluatedAt = new Date().toISOString();
                console.log(
                    `[stale-market-data] token=${token.symbol || token.token_address} ` +
                    `marketAgeSeconds=${ageLabel} lastTimestamp=${lastTimestamp} now=${evaluatedAt} reason=STALE_MARKET_DATA`
                );
                tradingBotRepository.insertLog(userId, {
                    logType: "WARNING",
                    tokenSymbol: token.symbol,
                    message: `Rejected: Market data stale (${ageLabel} seconds old) - ${token.symbol || token.token_address.slice(0, 8)}`,
                    meta: {
                        tokenAddress: token.token_address,
                        marketAgeSeconds: evaluation.marketAgeSeconds,
                        lastTimestamp,
                        evaluatedAt
                    }
                });
            }
            // Production Stabilization V2 (BUY Quality sprint, Section 3
            // observability requirement carried forward): a HIGH-risk
            // rejection is never silent either - same real log-row
            // convention as the freshness rejection above, listing the
            // actual riskReasons that pushed this candidate to HIGH so
            // the Founder can see exactly why, not just that it happened.
            if(evaluation.reason === "HIGH_RISK_REJECTED"){
                tradingBotRepository.insertLog(userId, {
                    logType: "WARNING",
                    tokenSymbol: token.symbol,
                    message: `Rejected: HIGH risk (${(evaluation.riskReasons || []).length} red flags) - ${token.symbol || token.token_address.slice(0, 8)}`,
                    meta: { tokenAddress: token.token_address, riskReasons: evaluation.riskReasons }
                });
            }
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

        // Production Stabilization Final, Section G/H: `evaluation` itself
        // (the entry gate's own real result - isReentry, the real
        // marketAgeSeconds it verified, decayFraction already on `live`)
        // was computed then discarded here before this fix - only
        // evaluation.live ever reached tradeManager.openPosition. If the
        // Founder later asks "why was this token allowed to reach a real
        // BUY," this closes the gap between "the signal looked fine" and
        // "the gate itself actually ran and passed" - persisted verbatim
        // by tradeManager.js, immutable, from the exact real decision.
        live.entryGateResult = {
            eligible: evaluation.eligible,
            isReentry: evaluation.isReentry ?? false,
            marketAgeSeconds: evaluation.marketAgeSeconds ?? null,
            decayFraction: live.decayFraction ?? null
        };

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
            reasons: live.reasons?.length ? live.reasons : (live.exclusionReason ? [live.exclusionReason] : []),
            // Production Hotfix V1.1, Section 3: real observability for
            // every candidate, not just the ones that end up BUY-tier -
            // lets the Founder see exactly how fresh the data behind
            // each decision actually is. marketAgeSeconds reuses
            // entryGateService's own freshness formula (never a second
            // copy); lastSnapshotAt is the token's own real
            // gmgn_tokens.updated_at; decisionTime is real "now, this
            // cycle"; snapshotSource is always the shared trending
            // snapshot here - candidates never come from the on-demand
            // fallback (that path is exclusively for already-open
            // positions, see refreshStaleHeldToken above).
            marketAgeSeconds: marketAgeSecondsFor(token),
            lastSnapshotAt: token.updated_at || token.last_seen || null,
            decisionTime: new Date().toISOString(),
            snapshotSource: "GMGN_TRENDING",
            // Transient - used below to compute Section H's Candidate
            // Card Target price, only for the rows that actually survive
            // the HOLD top-20 cut. Harmless extra properties:
            // replaceDecisionSnapshot only ever reads its own named
            // fields, never these.
            _token: token, _live: live
        };
        if(live.action === "BUY" || live.action === "STRONG BUY") qualifiedRows.push(row);
        else if(live.action === "HOLD") holdCandidates.push(row);
        else avoidCandidates.push(row);
    }
    holdCandidates.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const waitRows = holdCandidates.slice(0, 20);
    const avoidRows = avoidCandidates.slice(0, 5);

    // Section H (Candidate Card): a real "if bought right now" Target
    // price for every BUY/WATCH-tier row - reuses tradePlanService's
    // buildRiskBands via the active engine, the EXACT same function
    // tradeManager.js's own openPosition() calls at real BUY time, never
    // a second target-price formula. AVOID-tier rows never get one -
    // there's nothing to project for a token the engine is telling the
    // user to avoid. Computed only for rows that survive the caps above
    // (qualifiedRows is already the small real BUY-tier set; waitRows is
    // capped to 20) - never for the full scan universe.
    const activeEngine = productionEngineResolver.getActiveEngine();
    function attachTargetPrice(row){
        const signalStub = { participantScore: row._live.participantScore ?? 50, risk: row._live.risk, confidence: row._live.confidence };
        const riskBands = activeEngine.buildRiskBands(row._token, signalStub, botConfig.exitOverrides);
        row.targetPrice = riskBands?.target?.price ?? null;
    }
    qualifiedRows.forEach(attachTargetPrice);
    waitRows.forEach(attachTargetPrice);

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
//
// msSinceTokenSeen/extractFreshPriceAndLiquidity/refreshStaleHeldToken
// exported purely for this file's own regression test (Production
// Stabilization V1, Section A) - pure/near-pure functions, no other
// module calls them directly.
//
// runExitCycle is exported for scheduler/exitEvaluationScheduler.js - the
// independent, faster exit-only cadence (Exit Evaluation Interval
// sprint). manageOpenPositions is exported purely for this file's own
// regression test - no other module calls it directly.
module.exports = {
    runCycle, orderCandidates, buildLiveExecutionOptions,
    msSinceTokenSeen, extractFreshPriceAndLiquidity, refreshStaleHeldToken,
    HELD_POSITION_STALE_AFTER_MS,
    manageOpenPositions, runExitCycle
};
