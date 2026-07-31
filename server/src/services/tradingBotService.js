// services/tradingBotService.js - Trading Bot Dashboard business logic.
// Monitoring/control only this phase - START/STOP/PAUSE only flip a
// real status flag; no scan loop, no order execution, no GMGN/wallet
// integration exists yet. Every number returned is either a real
// database value or an explicit empty/placeholder state - never a
// fabricated figure standing in for data that doesn't exist yet.
//
// Sprint A, Goal 2 (auth/multi-tenancy foundation): every exported
// function now takes a leading userId, threaded straight through to
// tradingBotRepository - no logic changes otherwise, this file stays a
// thin wrapper.
//
// Never modifies Production V2's own CODE (researchEngineFactory.js/
// scoringConfig.js are never touched here or by any profile). It DOES
// now write the profile's engine-parameter fields (weights/tiers/
// min_liquidity_usd/etc.) onto trading_bot_config as plain data - see
// services/strategyProfileTranslator.js, which is what actually turns
// those columns into a philosophy override passed into the engine's
// pre-existing, already-generic override mechanism. Same distinction
// as always: this file changes CONFIG, never the engine's source.

const db = require("../database/connection");
const tradingBotRepository = require("../repositories/tradingBotRepository");
const tradingWalletRepository = require("../repositories/tradingWalletRepository");
const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const productionEngineResolver = require("../services/productionEngineResolver");
const strategyProfileConfig = require("../config/strategyProfileConfig");
const customObjectiveService = require("./customObjectiveService");
const onboardingService = require("./onboardingService");
const tradeManager = require("./tradeManager");
const walletService = require("./walletService");
const executionRepository = require("../repositories/executionRepository");
const tradingBotMissedOpportunityRepository = require("../repositories/tradingBotMissedOpportunityRepository");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");
const tradingBotFreshUniverseSnapshotRepository = require("../repositories/tradingBotFreshUniverseSnapshotRepository");
// Section J (Open Position fields): reuses MIN_TP_PCT for a read-only
// "Dynamic State" label - never re-implements or re-evaluates the real
// exit decision itself (that stays in tradeManager.js's closeIfDue).
const { MIN_TP_PCT } = require("./dynamicExitService");
const { buildSolanaTxUrl } = require("../utils/explorerUrl");
// Read-only constants (mismatchPenaltyPerPoint/maxCompletenessPenalty) -
// Position Detail's Confidence Breakdown recomputes computeConfidence()'s
// own display-only arithmetic from already-persisted numbers; this never
// calls the engine or re-scores anything.
const scoringConfig = require("../config/scoringConfig");
// Named envConfig, not config - this file already uses `config` as the
// local variable name for trading_bot_config everywhere else.
const envConfig = require("../config/env");

// Constitution v1.0 / Final Spec section 02: these fields belong to the
// Strategy Profile bundle (config/strategyProfileConfig.js) - they are
// NEVER independently settable through the public API, only ever
// changed as a side effect of switching strategy_profile. Silently
// stripped from any incoming payload before it ever reaches the
// repository, whether or not this request also changes the profile.
//
// Trading Configuration sprint: position_size_pct/max_position_size/
// max_open_positions are DELIBERATELY no longer in this list. The
// position-sizing audit found these three had no real reason to be
// profile-owned - they're money-management/risk-sizing choices, not
// part of the AI's philosophy (which tokens to buy, how to rank them).
// They're now genuinely user-controlled via updateTradingConfiguration()
// below, independent of strategy_profile - see TRADING_CONFIG_FIELDS and
// this file's own updateConfig() for how a profile switch still seeds
// sensible defaults for a never-customized account without ever
// clobbering a real user override (trading_config_customized_at).
const PROFILE_OWNED_FIELDS = [
    "min_confidence", "min_decay_fraction",
    "cooldown_win_minutes", "cooldown_loss_minutes",
    "cooldown_reversal_minutes", "cooldown_default_minutes",
    "opportunity_priority_enabled", "emi_enabled",
    // Profile-Aware Production V2 refactor: the engine/gate/exit
    // override fields (weights/tiers/min_liquidity_usd/min_volume_usd/
    // flatten_earliness/sm_bonus/quality_gate_overrides/fixed_tp_pct/
    // stop_loss_overrides/momentum_weakening_buyer_dominance_ratio) are
    // exactly as profile-owned as the fields above - same rule, same
    // enforcement, never independently settable through the public API.
    "weights", "tiers", "min_liquidity_usd", "min_volume_usd", "flatten_earliness", "sm_bonus",
    "quality_gate_overrides", "fixed_tp_pct", "stop_loss_overrides", "momentum_weakening_buyer_dominance_ratio",
    // Early Momentum Hunter refactor: acceleration_overrides is exactly as
    // profile-owned as the fields above (see config/strategyProfileConfig.js).
    "acceleration_overrides"
];

// Trading Configuration sprint: the fields a strategy-profile switch
// still SEEDS as real defaults, but only for an account that has never
// deliberately customized them (trading_bot_config.trading_config_customized_at
// is null) - see updateConfig()'s own profile-switch branch below.
const TRADING_CONFIG_DEFAULT_FIELDS = ["position_size_pct", "max_position_size", "max_open_positions"];

function getEngineSnapshot(){
    const activeVersion = productionEngineResolver.getActiveVersion();
    const meta = productionEngineResolver.REGISTRY[activeVersion];

    // Real, most-recent signal produced by the active engine (if any),
    // used only to show a genuine "latest signal" reading - never
    // presented as "the bot's own confidence" since the bot doesn't
    // scan/trade yet.
    // NOTE: prediction_history stores confidence/recommendation but never
    // persisted a "risk" column of its own (risk was part of the
    // in-memory signal object at prediction time, not written to a
    // column) - so "Market Risk" is honestly left null here rather than
    // guessed from other fields.
    const latest = db.prepare(`
        SELECT confidence, recommendation, token_symbol, prediction_time
        FROM prediction_history
        WHERE engine_version = ?
        ORDER BY id DESC LIMIT 1
    `).get(activeVersion);

    return {
        active: activeVersion,
        label: activeVersion === "production_v2" ? "Production_V2" : "Production_V1",
        engineName: meta.engineShortName,
        exitStrategy: meta.exitStrategyShortName,
        status: meta.status,
        latestSignal: latest ? {
            confidence: latest.confidence,
            recommendation: latest.recommendation,
            tokenSymbol: latest.token_symbol,
            predictionTime: latest.prediction_time
        } : null
    };
}

// Constitution / Final Spec section 02: strategy_profile is now the
// real ground truth for how aggressively the bot is configured - no
// longer inferred from a position_size_pct threshold guess (BALANCED
// and AGGRESSIVE both use 15% position sizing; only strategy_profile
// actually distinguishes them - see config/strategyProfileConfig.js).
function deriveCapitalMode(config){
    if(config.strategy_profile === "AGGRESSIVE") return "AGGRESSIVE";
    if(config.strategy_profile === "BALANCED") return "BALANCED";
    return "CONSERVATIVE";
}

// Reflects the REAL execution layer (Sprint 2, GMGN custodial - Path A),
// not the pre-Sprint-1 placeholder this used to hardcode. Cheap/local
// checks only (env + one wallet row lookup) - never a live GMGN call on
// every dashboard poll.
function getExecutorSnapshot(userId){

    if(!envConfig.GMGN_API_KEY){
        return { executor: "GMGN", executorStatus: "Not Configured", gmgnStatus: "Disconnected" };
    }

    const wallet = tradingWalletRepository.findByUserId(userId);
    const isFounderWallet = Boolean(
        wallet && envConfig.FOUNDER_WALLET_PUBLIC_KEY && wallet.public_key === envConfig.FOUNDER_WALLET_PUBLIC_KEY
    );

    if(!isFounderWallet){
        // GMGN itself is reachable - this account specifically isn't the
        // one wallet Founder Mode allows to reach LIVE execution yet.
        return { executor: "GMGN", executorStatus: "Not Authorized For Live Trading", gmgnStatus: "Connected" };
    }

    if(!envConfig.SOLANA_RPC_URL){
        return { executor: "GMGN", executorStatus: "Awaiting RPC Configuration", gmgnStatus: "Connected" };
    }

    return { executor: "GMGN", executorStatus: "Ready", gmgnStatus: "Connected" };

}

function getStatusBar(userId){
    const state = tradingBotRepository.getState(userId);
    const config = tradingBotRepository.getConfig(userId);
    const engine = getEngineSnapshot();

    return {
        tradingStatus: state.status,
        mode: state.mode,
        executionMode: config.execution_mode,
        engine,
        ...getExecutorSnapshot(userId),
        capitalMode: deriveCapitalMode(config),
        adaptiveExit: "Coming Soon"
    };
}

function getConfig(userId){
    return tradingBotRepository.getConfig(userId);
}

function updateConfig(userId, partial){
    const errors = [];
    if(partial.scan_interval_seconds != null && partial.scan_interval_seconds < 5){
        errors.push("Scan Interval must be at least 5 seconds.");
    }
    if(partial.execution_mode != null && !["REGULAR", "HIGH_THROUGHPUT"].includes(partial.execution_mode)){
        errors.push("Execution Mode must be either REGULAR or HIGH_THROUGHPUT.");
    }
    if(partial.strategy_profile != null && !strategyProfileConfig.PROFILE_NAMES.includes(partial.strategy_profile)){
        errors.push(`Strategy Profile must be one of: ${strategyProfileConfig.PROFILE_NAMES.join(", ")}.`);
    }
    if(errors.length) return { ok: false, errors };

    // Strip profile-owned fields from whatever the caller sent - they
    // are never independently settable (Constitution / Final Spec
    // section 02). Only re-added below, from the real bundle, when a
    // valid strategy_profile is present in this same request.
    const sanitized = { ...partial };
    for(const field of PROFILE_OWNED_FIELDS) delete sanitized[field];

    if(partial.strategy_profile != null){
        // strategyProfileConfig.resolveProfile() returns an Object.freeze()'d
        // bundle (shared, immutable) - `delete` on it is a silent no-op in
        // non-strict mode, so a fresh, mutable clone is required before
        // stripping any field from it, or a "customized" account would
        // (a) never actually get the fields stripped, and (b) risk mutating
        // the shared frozen object if freeze weren't in effect at all.
        let bundle = strategyProfileConfig.resolveProfile(partial.strategy_profile);
        // Trading Configuration sprint: a profile switch still seeds
        // position_size_pct/max_position_size/max_open_positions as real
        // DEFAULTS for an account that has never deliberately customized
        // them - but once a Founder has tuned their own numbers
        // (trading_config_customized_at set), a later profile switch
        // (chosen for the ranking/philosophy change, not the sizing) must
        // never silently reset them back to that profile's own defaults.
        const currentConfig = tradingBotRepository.getConfig(userId);
        if(currentConfig.trading_config_customized_at){
            bundle = { ...bundle };
            for(const field of TRADING_CONFIG_DEFAULT_FIELDS) delete bundle[field];
        }
        Object.assign(sanitized, bundle);
    }

    const updated = tradingBotRepository.updateConfig(userId, sanitized);

    // Onboarding's "Strategy selected" step requires a deliberate
    // choice, not the STABLE default every account already has -
    // stamped only when this request actually contains a real switch.
    if(partial.strategy_profile != null) tradingBotRepository.markStrategySelected(userId);

    // Trading Configuration sprint: stamped whenever this request
    // genuinely changes any of the now-independent sizing/slot fields -
    // regardless of which endpoint/caller triggered it, so a later
    // profile switch correctly knows to preserve them (see above).
    const tradingConfigFieldsChanged = [...TRADING_CONFIG_DEFAULT_FIELDS, "position_sizing_mode", "fixed_position_size_usd"]
        .some(field => partial[field] !== undefined);
    if(tradingConfigFieldsChanged) tradingBotRepository.markTradingConfigCustomized(userId);

    tradingBotRepository.insertLog(userId, {
        logType: "SYSTEM",
        message: partial.strategy_profile != null
            ? `Bot configuration updated - Strategy Profile switched to ${partial.strategy_profile}.`
            : "Bot configuration updated."
    });
    // Re-fetch whenever a side-stamp (strategy_selected_at or the new
    // trading_config_customized_at) happened after `updated` was already
    // read, so the returned config is never one write behind.
    const needsRefetch = partial.strategy_profile != null || tradingConfigFieldsChanged;
    return { ok: true, config: needsRefetch ? tradingBotRepository.getConfig(userId) : updated };
}

// Production Stabilization V1 (Sections D/E/Q): the real balance, never
// a self-reported one. Returns 0 (never a fabricated positive figure)
// when no real balance is available yet - a Founder can still set an
// allocation % ahead of funding their wallet, it just starts at $0 until
// a real balance exists.
function computeInitialCapitalFromReal(real, allocationPct){
    return real?.solUsd != null ? real.solUsd * (allocationPct / 100) : 0;
}

// Trading Configuration sprint: the dashboard's real source of truth for
// "how much capital is available for new trades" - reuses
// walletService.getRealWalletBalance() (Trust Layer sprint, already
// proven) for the real on-chain SOL balance/price, never a second GMGN
// price probe.
//
// Production Stabilization V1 (Sections D/E/Q): the self-reported
// deposited_balance_usd fallback is gone - walletBalanceSource is only
// ever REAL or an honest UNAVAILABLE, never a stand-in number. Every
// call also write-throughs a fresh initial_capital (Trading Balance)
// from this real balance, keeping tradingBotEngine.js's runCycle hot
// path (getPortfolio() - must stay synchronous/DB-only, never RPC-
// dependent) in sync without ever making that hot path itself async.
// scheduler/walletBalanceSyncScheduler.js covers the same sync on a
// timer, for accounts whose dashboard isn't open.
async function getTradingConfiguration(userId){

    const config = tradingBotRepository.getConfig(userId);
    const real = await walletService.getRealWalletBalance(userId);

    let walletBalanceUsd = null, walletBalanceSol = null, walletBalanceSource = "UNAVAILABLE";
    const solUsdPrice = real?.solUsdPrice ?? null;

    if(real && real.solUsd != null){
        walletBalanceUsd = real.solUsd;
        walletBalanceSol = real.solAmount;
        walletBalanceSource = "REAL";

        const freshInitialCapital = computeInitialCapitalFromReal(real, config.allocation_pct);
        if(freshInitialCapital !== config.initial_capital){
            tradingBotRepository.updateInitialCapital(userId, freshInitialCapital);
            config.initial_capital = freshInitialCapital;
        }
    }

    const tradingAllocationUsd = config.initial_capital;
    const tradingAllocationSol = solUsdPrice ? tradingAllocationUsd / solUsdPrice : null;

    const reservedUsd = walletBalanceUsd != null ? Math.max(0, walletBalanceUsd - tradingAllocationUsd) : null;
    const reservedSol = solUsdPrice != null && reservedUsd != null ? reservedUsd / solUsdPrice : null;

    const portfolio = getPortfolio(userId);

    return {
        walletBalanceUsd, walletBalanceSol, walletBalanceSource,
        tradingAllocationUsd, tradingAllocationSol,
        reservedUsd, reservedSol,
        availableCashUsd: portfolio.availableCash,
        solUsdPrice,
        sizing: {
            mode: config.position_sizing_mode,
            positionSizePct: config.position_size_pct,
            fixedPositionSizeUsd: config.fixed_position_size_usd,
            maxPositionSize: config.max_position_size,
            maxOpenPositions: config.max_open_positions,
            minOrderSize: config.min_order_size,
            // Exit Evaluation Interval sprint: independent of scan_interval_seconds
            // (BUY-side scanning) - see scheduler/exitEvaluationScheduler.js.
            exitEvaluationIntervalSeconds: config.exit_evaluation_interval_seconds
        },
        customized: Boolean(config.trading_config_customized_at)
    };

}

// Trading Configuration sprint: the ONE user-facing entry point for the
// four fields the position-sizing audit found were needlessly
// profile-owned (plus min_order_size, already free but with no UI
// before this). Delegates to updateConfig() above for the actual
// write/stamp/log - never a second config-writing code path - this
// function's only job is real, specific validation with real error
// messages for this page.
function updateTradingConfiguration(userId, partial){

    const errors = [];
    const patch = {};

    if(partial.positionSizingMode != null){
        if(!["PERCENT", "FIXED_USD"].includes(partial.positionSizingMode)){
            errors.push("Position Sizing Mode must be either PERCENT or FIXED_USD.");
        }
        else patch.position_sizing_mode = partial.positionSizingMode;
    }
    if(partial.positionSizePct != null){
        const pct = Number(partial.positionSizePct);
        if(!Number.isFinite(pct) || pct <= 0 || pct > 100) errors.push("Position Size % must be a number between 0 and 100.");
        else patch.position_size_pct = pct;
    }
    if(partial.fixedPositionSizeUsd !== undefined){
        if(partial.fixedPositionSizeUsd === null) patch.fixed_position_size_usd = null;
        else{
            const usd = Number(partial.fixedPositionSizeUsd);
            if(!Number.isFinite(usd) || usd <= 0) errors.push("Fixed Position Size must be a positive USD amount.");
            else patch.fixed_position_size_usd = usd;
        }
    }
    if(partial.maxPositionSize != null){
        const cap = Number(partial.maxPositionSize);
        if(!Number.isFinite(cap) || cap <= 0) errors.push("Max Position Size must be a positive USD amount.");
        else patch.max_position_size = cap;
    }
    if(partial.maxOpenPositions != null){
        const slots = Number(partial.maxOpenPositions);
        if(!Number.isInteger(slots) || slots < 1) errors.push("Max Open Positions must be a whole number of at least 1.");
        else patch.max_open_positions = slots;
    }
    if(partial.minOrderSize != null){
        const floor = Number(partial.minOrderSize);
        if(!Number.isFinite(floor) || floor <= 0) errors.push("Min Order Size must be a positive USD amount.");
        else patch.min_order_size = floor;
    }
    // Exit Evaluation Interval sprint: independent of scan_interval_seconds
    // (BUY-side scanning, not editable from this form) - governs only how
    // often scheduler/exitEvaluationScheduler.js re-checks this user's own
    // OPEN positions for Dynamic Exit/Stop Loss.
    if(partial.exitEvaluationIntervalSeconds != null){
        const seconds = Number(partial.exitEvaluationIntervalSeconds);
        if(!Number.isInteger(seconds) || seconds < 1 || seconds > 30){
            errors.push("Exit Evaluation Interval must be a whole number of seconds between 1 and 30.");
        }
        else patch.exit_evaluation_interval_seconds = seconds;
    }

    if(errors.length) return { ok: false, errors };
    if(!Object.keys(patch).length) return { ok: false, errors: ["No valid Trading Configuration fields were provided."] };

    return updateConfig(userId, patch);

}

// Custom Objective AI Advisor (Constitution clause 7 / Final Spec
// section 05) - thin pass-through to the stateless service. Never
// starts the bot itself; the caller (tradingBotController.js) only
// ever returns the analysis for the user to review and act on. No
// userId needed - stateless, not scoped to any bot.
function analyzeCustomObjective(input){
    return customObjectiveService.analyze(input || {});
}

// Every figure below is computed from real rows (currently empty for a
// fresh account, since no execution layer exists yet) - a fresh install
// genuinely shows Available Cash = Initial Capital and every other
// figure at its real, honest zero, not a placeholder pretending to be
// a live P&L.
function getPortfolio(userId){
    const config = tradingBotRepository.getConfig(userId);
    // All-time - drives every REPORTING field below (totalTrades/winRate/
    // profitFactor/totalFees/closedProfit) unconditionally. Reset Trading
    // Capital (config.ledger_reset_at) must never make a user's historical
    // track record look like it vanished - PnL history stays intact
    // regardless of a ledger reset.
    const closed = tradingBotRepository.sumClosedTrades(userId);
    // Reset Trading Capital feature: availableCash/equity are the only
    // figures a ledger reset is meant to change. When ledger_reset_at is
    // set, only trades closed AFTER that moment count toward the cash
    // ledger - pre-reset realized P&L (however negative) no longer
    // depresses availableCash below the fresh baseline, without deleting
    // or altering a single trade row. Unset (the default for every
    // account that has never reset) reproduces the exact original
    // all-time formula, byte for byte.
    const cashClosed = config.ledger_reset_at
        ? tradingBotRepository.sumClosedTradesSince(userId, config.ledger_reset_at)
        : closed;
    const open = tradingBotRepository.sumOpenPositions(userId);

    const availableCash = config.initial_capital + cashClosed.realizedPnl - open.openValueAtEntry;
    const unrealizedPnl = open.openMarketValue - open.openValueAtEntry;
    const equity = availableCash + open.openMarketValue;

    const totalTrades = closed.closedCount;
    const winRate = totalTrades > 0 ? (closed.winCount / totalTrades) * 100 : null;
    const profitFactor = closed.grossLoss > 0 ? closed.grossWin / closed.grossLoss : (closed.grossWin > 0 ? Infinity : null);

    return {
        availableCash,
        equity,
        openPositionValue: open.openMarketValue,
        closedProfit: closed.realizedPnl,
        unrealizedProfit: unrealizedPnl,
        realizedProfit: closed.realizedPnl,
        totalFees: closed.totalFees,
        totalTrades,
        winRate,
        profitFactor: Number.isFinite(profitFactor) ? profitFactor : null,
        maxDrawdownPct: tradingBotRepository.computeMaxDrawdownPct(userId) // real, from trading_bot_equity_snapshot - null until 2+ snapshots exist
    };
}

// Trust/UX sprint: getPortfolio() above stays exactly as it is - it's
// also called synchronously, twice, inside tradingBotEngine.js's own
// runCycle() hot path (availableCash sizing + the end-of-cycle equity
// snapshot). Making that shared function async/network-dependent would
// mean a flaky RPC endpoint could stall the trading loop itself - a
// strictly worse regression than a dashboard stat being briefly stale.
// So the real-balance reconciliation is a SEPARATE, additive read: the
// unchanged ledger (ok to keep being self-reported/ledger-only for the
// engine's own purposes) plus the real on-chain balance
// (walletService.getRealWalletBalance, already fails soft), with an
// explicit, never-fabricated syncDeltaUsd - omitted entirely when the
// real balance isn't available, never guessed.
async function getPortfolioReconciliation(userId){
    const ledger = getPortfolio(userId);
    const onChain = await walletService.getRealWalletBalance(userId);
    const syncDeltaUsd = onChain?.solUsd != null ? ledger.equity - onChain.solUsd : null;
    return { ...ledger, onChain, syncDeltaUsd };
}

// Live Decision Center sprint: real, already-computed decision-snapshot
// rows (migration 050) - never a fabricated queue, never the full
// ~12,000-token scan universe. Malformed/missing reasons_json falls back
// to an honest empty array, never a guess.
function mapSnapshotRow(r){
    let reasons = [];
    if(r.reasons_json){
        try{ reasons = JSON.parse(r.reasons_json); }
        catch(e){ /* malformed - honest empty, never guessed */ }
    }
    return {
        tokenAddress: r.token_address, tokenSymbol: r.token_symbol,
        action: r.action, confidence: r.confidence, risk: r.risk,
        tier: r.tier, rank: r.rank, priorityScore: r.priority_score,
        reasons,
        // Section H (Candidate Card): real "if bought now" projection -
        // null for AVOID-tier rows and whenever the engine couldn't
        // produce one (no real market_cap yet), never fabricated.
        targetPrice: r.target_price ?? null,
        // Production Hotfix V1.1, Section 3: real freshness observability.
        marketAgeSeconds: r.market_age_seconds ?? null,
        lastSnapshotAt: r.last_snapshot_at ?? null,
        decisionTime: r.decision_time ?? null,
        snapshotSource: r.snapshot_source ?? null
    };
}

// Live Decision Center: the dashboard's new home view - shows the AI
// thinking in real time, not just what it already decided. Every field
// is real: the snapshot table (item above), the last real cycle-summary/
// Filtering log rows (tradingBotEngine.js's runCycle), and two small,
// genuinely new health checks (RPC ping, wallet configured) - none of
// which touch the frozen scoring/ranking engine.
async function getDecisionCenter(userId){

    const state = tradingBotRepository.getState(userId);
    const config = tradingBotRepository.getConfig(userId);
    const snapshot = tradingBotRepository.findDecisionSnapshot(userId);

    // findDecisionSnapshot already orders by rank (BUY/STRONG BUY tier
    // first, by real leaderboard position), then confidence - so
    // buyQueue/currentRanking need no re-sorting here.
    const buyQueue = snapshot.filter(r => r.action === "BUY" || r.action === "STRONG BUY").map(mapSnapshotRow);
    const waitQueue = snapshot.filter(r => r.action === "HOLD").map(mapSnapshotRow);
    const avoidSample = snapshot.filter(r => r.action !== "BUY" && r.action !== "STRONG BUY" && r.action !== "HOLD").map(mapSnapshotRow);

    const recentLog = tradingBotRepository.findRecentLog(userId, 10);
    const cycleLog = recentLog.find(l => l.message.startsWith("Cycle complete:"));
    const filteringLog = recentLog.find(l => l.message.startsWith("Filtering:"));
    let filteringMeta = null;
    if(filteringLog?.meta_json){
        try{ filteringMeta = JSON.parse(filteringLog.meta_json); }
        catch(e){ /* malformed - honest null, never guessed */ }
    }

    // Cycle/Engine status: real, derived from the last cycle-summary log's
    // own timestamp vs. this user's own scan_interval_seconds - never a
    // fabricated heartbeat. A 3x grace window absorbs ordinary scheduler
    // jitter without flip-flopping between ON_SCHEDULE/DELAYED every tick.
    let cycleStatus = "NO_CYCLE_YET";
    if(state.status !== "RUNNING") cycleStatus = "STOPPED";
    else if(cycleLog){
        const lastCycleAgeSec = (Date.now() - new Date(`${String(cycleLog.created_at).replace(" ", "T")}Z`).getTime()) / 1000;
        cycleStatus = lastCycleAgeSec <= config.scan_interval_seconds * 3 ? "ON_SCHEDULE" : "DELAYED";
    }

    // RPC Status: one cheap real ping via the same connection provider the
    // execution layer already uses - never a fabricated "connected".
    let rpcStatus = "NOT_CONFIGURED";
    if(envConfig.SOLANA_RPC_URL){
        try{
            const { connectionProvider } = require("./execution");
            await connectionProvider.getConnection().getSlot();
            rpcStatus = "CONNECTED";
        }
        catch(e){ rpcStatus = "UNAVAILABLE"; }
    }

    const wallet = await walletService.getStatus(userId);
    const walletStatus = !wallet.tradingWallet
        ? "NOT_CONFIGURED"
        : (wallet.tradingWallet.realBalanceUnavailableReason ? "CONFIGURED_UNVERIFIED" : "CONNECTED");

    const openCount = tradingBotRepository.countOpenPositions(userId);
    const portfolio = getPortfolio(userId);

    return {
        botStatus: state.status,
        cycleStatus,
        engineStatus: cycleStatus,
        rpcStatus,
        walletStatus,
        lastCycleAt: cycleLog?.created_at ?? null,
        qualifiedCandidateCount: filteringMeta?.qualifiedCount ?? buyQueue.length,
        holdCount: filteringMeta?.holdCount ?? null,
        avoidCount: filteringMeta?.avoidCount ?? null,
        buyQueue,
        waitQueue,
        avoidSample,
        currentRanking: buyQueue,
        currentOpportunity: buyQueue[0] ?? null,
        openSlot: Math.max(0, config.max_open_positions - openCount),
        remainingCash: portfolio.availableCash
    };

}

// Missed Winners page (Momentum Validation System sprint, this sprint's
// own stated top priority): real, SETTLED outcomes only - a still-pending
// row (outcome not yet evaluated) never appears here, since "Hasil Akhir"
// must be a real, real number, never a guess or a placeholder "...".
function getMissedWinners(userId, limit){
    return tradingBotMissedOpportunityRepository.findEvaluated(userId, limit).map(row => ({
        tokenAddress: row.token_address,
        tokenSymbol: row.token_symbol,
        rankAtSkip: row.rank_at_skip,
        priorityScoreAtSkip: row.priority_score_at_skip,
        reason: row.reason,
        // Phase 2: the same real bottleneck vocabulary the Bottleneck
        // Report uses, so "kenapa tidak dibeli" reads consistently
        // everywhere on the dashboard.
        category: categorizeBottleneckReason(row.reason),
        priceAtSkip: row.price_at_skip,
        skippedAt: row.skipped_at,
        outcomePrice: row.outcome_price,
        outcomeReturnPct: row.outcome_return_pct,
        outcomeEvaluatedAt: row.outcome_evaluated_at,
        hasOutcome: row.outcome_price != null
    }));
}

// Self-Comparison (Momentum Validation System sprint): for each real
// sibling captured at buy time (tradingBotEngine.js's runCycle, same
// cycle's other real ranked BUY-tier candidates), compute a real,
// on-demand comparison against a real price baseline/peak from
// token_price_history - the exact same already-collected time series
// the Missed Opportunity outcome job reads, never new GMGN polling.
// Purely observational - never read back into ranking or scoring.
function computeSiblingComparison(position, siblings){
    return siblings.map(sib => {
        const baseline = tokenPriceHistoryRepository.findPriceAtOrAfter(sib.tokenAddress, position.opened_at);
        if(!baseline || !baseline.price){
            return { ...sib, outcomeReturnPct: null, outperformed: null, reason: "No real price history collected for this sibling around the same time." };
        }
        const range = tokenPriceHistoryRepository.findRangeForToken(sib.tokenAddress, position.opened_at);
        const peak = range.length ? Math.max(...range.map(r => Number(r.price))) : Number(baseline.price);
        const outcomeReturnPct = ((peak / Number(baseline.price)) - 1) * 100;
        return {
            ...sib,
            outcomeReturnPct,
            outperformed: position.mfe_pct != null ? outcomeReturnPct > position.mfe_pct : null
        };
    });
}

// Self-Audit / Performance Report (Momentum Validation System sprint):
// every real close reason ever written to trading_bot_trades.reason,
// categorized - zero new engine logic, purely a GROUP BY of already-real
// data. MOMENTUM_WEAKENING is CRAB's real "took profit" path (TP15 is a
// floor, not a ceiling, so the position only closes once momentum fails
// ABOVE the 15% floor) - classified TP when roi_pct >= 15, otherwise a
// Dynamic-Exit reversal (momentum died before reaching the floor). The
// `_NO_REAL_BALANCE` suffix (a different, pre-existing case: "we decided
// to sell but there was nothing there") is stripped before categorizing,
// so it's never double-counted as its own bucket.
function categorizeCloseReason(rawReason, roiPct){
    const reason = String(rawReason).replace(/_NO_REAL_BALANCE$/, "");
    if(reason === "STOP_LOSS") return "SL";
    if(reason === "REVERSAL") return "DYNAMIC_EXIT";
    if(reason === "MOMENTUM_WEAKENING") return (roiPct ?? 0) >= 15 ? "TP" : "DYNAMIC_EXIT";
    if(reason === "SELL_MANUAL") return "MANUAL";
    if(reason === "SELL_EXTERNAL") return "EXTERNAL";
    if(reason.startsWith("RUG_DETECTED")) return "RUG";
    return "OTHER";
}

// Phase 2 (Live Validation & Bottleneck Elimination): every real reason
// trading_bot_missed_opportunity.reason can now contain (entryGateService's
// own real rejection reasons, tradeManager.openPosition's own real
// post-eligibility failures, and the two new loop-break "never got a
// turn" reasons), mapped into the Founder's own bottleneck vocabulary -
// zero new engine logic, purely a categorization of already-real data.
// RPC Error / Wallet Error are deliberately NOT mapped here - those
// already have a real, dedicated home in the `executions` table (see
// getBottleneckReport below), never guessed from this table's reasons.
function categorizeBottleneckReason(rawReason){
    const reason = String(rawReason);
    if(reason === "MAX_OPEN_POSITIONS_REACHED" || reason === "SLOT_FULL_BEFORE_TURN") return "OPEN_SLOT_FULL";
    if(reason === "INSUFFICIENT_AVAILABLE_CASH" || reason === "CASH_EXHAUSTED_BEFORE_TURN") return "TRADING_BALANCE_HABIS";
    if(reason.startsWith("QUALITY_GATE_") || reason === "REENTRY_STRUCTURAL_RED_FLAG" || reason === "NO_RISK_BANDS_AVAILABLE") return "RISK_REJECTED";
    if(reason === "CONFIDENCE_BELOW_FLOOR") return "ENTRY_GATE_REJECTED";
    if(reason === "ALREADY_OPEN_FOR_TOKEN") return "ALREADY_HOLDING_SIMILAR_POSITION";
    if(reason.startsWith("COOLDOWN_ACTIVE_")) return "COOLDOWN";
    if(reason === "DECISION_TOO_STALE" || reason === "NO_REAL_PRICE") return "OPPORTUNITY_EXPIRED";
    if(reason.startsWith("EXECUTION_")) return "EXECUTION_FAILED";
    return "OTHER";
}

// Self-Audit (this sprint's mandated 24h automatic report) / Performance
// Report - computed live, on every request, over a real rolling window
// (the proven datetime('now', '-N hours') convention, not a stored daily
// snapshot - see the plan's own note on why that's deferred). Every
// number is real; Entry Timing Score-style metrics needing new
// qualify-time/sightings history stay the honest "Collecting Data" state
// getMomentumKpi already established.
function getSelfAudit(userId, hours = 24){

    const logRows = tradingBotRepository.findLogSince(userId, hours);
    let scanned = 0, qualified = 0;
    for(const row of logRows){
        if(!row.meta_json) continue;
        let meta;
        try{ meta = JSON.parse(row.meta_json); }
        catch(e){ continue; /* malformed - skip this row's contribution, never guess */ }
        if(row.message.startsWith("Cycle complete:") && meta.scanned != null) scanned += meta.scanned;
        if(row.message.startsWith("Filtering:") && meta.qualifiedCount != null) qualified += meta.qualifiedCount;
    }

    const bought = tradingBotRepository.countPositionsOpenedSince(userId, hours);
    const trades = tradingBotRepository.findTradesClosedSince(userId, hours);
    const closed = trades.length;

    const counts = { TP: 0, SL: 0, DYNAMIC_EXIT: 0, MANUAL: 0, EXTERNAL: 0, RUG: 0, OTHER: 0 };
    for(const t of trades) counts[categorizeCloseReason(t.reason, t.roi_pct)]++;

    const durations = trades.map(t => t.duration_seconds).filter(d => d != null);
    const avgHoldingTimeSeconds = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : null;

    const rankValues = tradingBotRepository.findRankAtEntryValuesSince(userId, hours);
    const avgEntryRank = rankValues.length ? rankValues.reduce((s, r) => s + r.rankAtEntry, 0) / rankValues.length : null;

    // Phase 2 (Live Validation & Bottleneck Elimination): real, windowed
    // Average Entry Delay and Missed Winner count - "dalam N jam" needs
    // both scoped to the same real window, not the all-time figures.
    const entryDelayValues = tradingBotRepository.findEntryDelayValuesSince(userId, hours);
    const avgEntryDelaySeconds = entryDelayValues.length
        ? entryDelayValues.reduce((s, r) => s + r.delaySeconds, 0) / entryDelayValues.length
        : null;
    const missedWinnerCount = tradingBotMissedOpportunityRepository.countEvaluatedSince(userId, hours);

    return {
        windowHours: hours,
        scanned, qualified, bought, closed,
        tp: counts.TP, sl: counts.SL, dynamicExit: counts.DYNAMIC_EXIT,
        manual: counts.MANUAL, external: counts.EXTERNAL, rug: counts.RUG, other: counts.OTHER,
        avgHoldingTimeSeconds,
        avgEntryRank,
        avgEntryDelaySeconds,
        missedWinnerCount
    };

}

// System Throughput (Phase 2: Live Validation & Bottleneck Elimination) -
// real, windowed measures of how much the bot is actually doing, not
// just what it decided. Average Queue Length and Average Candidate Per
// Cycle are documented here as the SAME underlying number (the real
// qualifiedCount already written into every cycle's "Filtering: ..." log
// row) under the phase's two different names - not two separate metrics
// pretending to be independent.
function getSystemThroughput(userId, hours = 24){

    const elapsedHours = Math.max(hours, 1 / 60);

    const opensSince = tradingBotRepository.countPositionsOpenedSince(userId, hours);
    const trades = tradingBotRepository.findTradesClosedSince(userId, hours);

    const openPositionPerHour = opensSince / elapsedHours;
    const closePositionPerHour = trades.length / elapsedHours;

    const durations = trades.map(t => t.duration_seconds).filter(d => d != null);
    const avgPositionDurationSeconds = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : null;

    // Real per-cycle samples (migration 054) - null/empty for any window
    // that predates this Phase-2 instrumentation, never guessed.
    const samples = tradingBotRepository.findThroughputSamplesSince(userId, hours);
    const avgSimultaneousPosition = samples.length
        ? samples.reduce((s, r) => s + (r.openPositionCount ?? 0), 0) / samples.length
        : null;
    const avgIdleCash = samples.length
        ? samples.reduce((s, r) => s + (r.availableCash ?? 0), 0) / samples.length
        : null;

    // Capital Utilization - real, from getPortfolio()'s own already-
    // computed fields at read time, no new tracking.
    const portfolio = getPortfolio(userId);
    const capitalUtilizationPct = portfolio.equity > 0 ? (portfolio.openPositionValue / portfolio.equity) * 100 : null;

    // Average Queue Length / Average Candidate Per Cycle - both the real
    // qualifiedCount already written into every cycle's own "Filtering: ..."
    // log row (tradingBotEngine.js's runCycle), averaged over the window.
    const logRows = tradingBotRepository.findLogSince(userId, hours);
    let qualifiedSum = 0, cycleCount = 0;
    for(const row of logRows){
        if(!row.meta_json) continue;
        let meta;
        try{ meta = JSON.parse(row.meta_json); }
        catch(e){ continue; }
        if(row.message.startsWith("Filtering:") && meta.qualifiedCount != null){
            qualifiedSum += meta.qualifiedCount;
            cycleCount++;
        }
    }
    const avgCandidatePerCycle = cycleCount ? qualifiedSum / cycleCount : null;

    return {
        windowHours: hours,
        openPositionPerHour,
        closePositionPerHour,
        avgSimultaneousPosition,
        avgPositionDurationSeconds,
        capitalUtilizationPct,
        avgIdleCash,
        avgQueueLength: avgCandidatePerCycle,
        avgCandidatePerCycle
    };

}

// Bottleneck Report (Phase 2: Live Validation & Bottleneck Elimination) -
// the exact shape the phase describes: real counts, then real cause
// percentages. Computed live on every request, same reasoning as
// getSelfAudit (no stored/stale snapshot). Never concludes a bottleneck
// "is" the problem - just reports the real numbers; the phase explicitly
// reserves that judgment for the Founder.
function getBottleneckReport(userId, hours = 24){

    const audit = getSelfAudit(userId, hours);
    const openPosition = tradingBotRepository.countOpenPositions(userId); // real, current snapshot - not window-bound, since a position opened before the window can still be open now

    const missedRows = tradingBotMissedOpportunityRepository.findAllSince(userId, hours);
    const categoryCounts = {};
    for(const row of missedRows){
        const category = categorizeBottleneckReason(row.reason);
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    }
    const totalMissed = missedRows.length;
    const causes = Object.entries(categoryCounts).map(([category, count]) => ({
        category,
        count,
        pct: totalMissed ? Math.round((count / totalMissed) * 1000) / 10 : 0
    })).sort((a, b) => b.count - a.count);

    // Execution Failed / RPC / Wallet errors: real, already-recorded BUY
    // execution failures - never guessed from this table's text, the
    // real error_message is surfaced directly instead.
    const failedExecutions = executionRepository.findFailedBuysSince(userId, hours);
    const latestExecutionError = failedExecutions.length ? {
        status: failedExecutions[0].status,
        message: failedExecutions[0].error_message,
        at: failedExecutions[0].created_at
    } : null;

    // Fresh BUY Universe RFC, pipeline observability enhancement: the
    // one funnel stage (collector -> fresh universe) with no prior
    // visibility, before this report's existing qualified/bought/closed
    // stages (which are already real, per-user, per-cycle numbers above).
    // Tick-global, not user-scoped - every due user in a tick shares the
    // exact same fresh universe - so this answers "how much is being
    // filtered out before I even see it," same question the rest of
    // this report already answers for the later stages.
    const freshUniverseSnapshot = tradingBotFreshUniverseSnapshotRepository.sumSince(hours);
    const collectorTotalAvg = freshUniverseSnapshot.collectorTotalAvg;
    const freshUniverseAvg = freshUniverseSnapshot.freshUniverseAvg;
    const droppedPct = (collectorTotalAvg != null && collectorTotalAvg > 0)
        ? Math.round(((collectorTotalAvg - freshUniverseAvg) / collectorTotalAvg) * 1000) / 10
        : null;

    return {
        windowHours: hours,
        freshUniverse: {
            tickCount: freshUniverseSnapshot.tickCount,
            collectorTotalAvg,
            freshUniverseAvg,
            droppedPct
        },
        qualified: audit.qualified,
        bought: audit.bought,
        openPosition,
        closed: audit.closed,
        missedWinner: audit.missedWinnerCount,
        totalMissedOpportunities: totalMissed,
        causes,
        executionFailureCount: failedExecutions.length,
        latestExecutionError
    };

}

// Target Achievement summary (Phase 2's own explicit deliverable): the
// Founder's four questions, each answered with the real number already
// computed above - never a "yes"/"no" verdict from CRAB itself. The
// phase explicitly reserves that judgment for the Founder; this only
// ever assembles real data, it never concludes.
function getTargetAchievementSummary(userId, hours = 24){

    const throughput = getSystemThroughput(userId, hours);
    const kpi = getMomentumKpi(userId);
    const audit = getSelfAudit(userId, hours);

    return {
        windowHours: hours,
        manyOpenPositions: { openPositionPerHour: throughput.openPositionPerHour, bought: audit.bought },
        manyClosePositions: { closePositionPerHour: throughput.closePositionPerHour, closed: audit.closed },
        fastEntry: { avgEntryDelaySeconds: audit.avgEntryDelaySeconds },
        noMomentumLoss: { avgTimeToPeakSeconds: kpi.avgTimeToPeakSeconds, avgHoldingTimeSeconds: audit.avgHoldingTimeSeconds }
    };

}

// Momentum KPI sprint: measures whether Momentum Hunter is genuinely
// getting faster at catching momentum over time. Momentum Validation
// System sprint (Sprint 5) added real Average Entry Delay (candidate
// sightings, migration 052) and Average Time To Peak (mfe_at, migration
// 048/051) - both computed here now. Entry Timing Score, Momentum
// Capture Score, Late Entry %, and Missed Opportunity % still need
// design decisions (a defensible denominator, a scoring formula) this
// sprint didn't resolve - left explicitly null with a reason, never a
// fabricated score.
function getMomentumKpi(userId){

    const trades = tradingBotRepository.findAllTradesChronological(userId);

    if(!trades.length){
        return {
            totalTrades: 0,
            avgHoldingTimeSeconds: null,
            tradesPerHour: null,
            closesPerHour: null,
            avgRankAtEntry: null,
            avgTimeToSellSeconds: null,
            avgTimeToSellSampleSize: 0,
            avgEntryDelaySeconds: null, avgTimeToPeakSeconds: null,
            entryTimingScore: null, momentumCaptureScore: null, lateEntryPct: null, missedOpportunityPct: null,
            deferredMetricsReason: "Entry Timing/Momentum Capture Score and Missed Opportunity % need a scoring design this sprint didn't resolve - deferred, not fabricated."
        };
    }

    const durations = trades.map(t => t.duration_seconds).filter(d => d != null);
    const avgHoldingTimeSeconds = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : null;

    // Real historical throughput since the first-ever trade - does not
    // exclude STOPPED/PAUSED downtime (a real, if imperfect, measure;
    // never a fabricated one).
    const firstOpenedAt = new Date(`${String(trades[0].opened_at).replace(" ", "T")}Z`).getTime();
    const lastClosedAt = new Date(`${String(trades[trades.length - 1].closed_at).replace(" ", "T")}Z`).getTime();
    const elapsedHours = Math.max((lastClosedAt - firstOpenedAt) / 3600000, 1 / 60);
    const tradesPerHour = trades.length / elapsedHours;
    const closesPerHour = trades.length / elapsedHours; // every trade row IS a close

    const rankValues = tradingBotRepository.findRankAtEntryValues(userId);
    const avgRankAtEntry = rankValues.length
        ? rankValues.reduce((s, r) => s + r.rankAtEntry, 0) / rankValues.length
        : null;

    // Average Time To Sell (LIVE only) - real on-chain confirmation
    // latency (completed_at - created_at) for the execution that closed
    // each trade, via close_execution_id (migration 046). Simulation
    // trades have no close_execution_id - correctly excluded, never
    // counted as zero latency.
    const execDurationsSec = [];
    for(const t of trades){
        if(t.close_execution_id == null) continue;
        const exec = executionRepository.findById(userId, t.close_execution_id);
        if(!exec || !exec.completed_at) continue;
        const ms = new Date(`${String(exec.completed_at).replace(" ", "T")}Z`).getTime() - new Date(`${String(exec.created_at).replace(" ", "T")}Z`).getTime();
        if(Number.isFinite(ms) && ms >= 0) execDurationsSec.push(ms / 1000);
    }
    const avgTimeToSellSeconds = execDurationsSec.length ? execDurationsSec.reduce((s, d) => s + d, 0) / execDurationsSec.length : null;

    // Average Entry Delay (Momentum Validation System sprint): real, only
    // for positions opened after the candidate-sightings table (migration
    // 052) started recording - a position with no matching sighting row
    // (e.g. Opportunity Priority was off that cycle, or it predates this
    // sprint) is correctly excluded, never counted as zero delay.
    const entryDelayValues = tradingBotRepository.findEntryDelayValues(userId);
    const avgEntryDelaySeconds = entryDelayValues.length
        ? entryDelayValues.reduce((s, r) => s + r.delaySeconds, 0) / entryDelayValues.length
        : null;

    // Average Time To Peak (Momentum Validation System sprint): real,
    // from mfe_at - only positions that ever recorded a real positive
    // excursion have one.
    const timeToPeakValues = tradingBotRepository.findTimeToPeakValues(userId);
    const avgTimeToPeakSeconds = timeToPeakValues.length
        ? timeToPeakValues.reduce((s, r) => s + r.delaySeconds, 0) / timeToPeakValues.length
        : null;

    return {
        totalTrades: trades.length,
        avgHoldingTimeSeconds,
        tradesPerHour,
        closesPerHour,
        avgRankAtEntry,
        avgTimeToSellSeconds,
        avgTimeToSellSampleSize: execDurationsSec.length, // 0 = no real LIVE closes yet - shown as "N/A (simulation)" by the caller, not a fake zero
        avgEntryDelaySeconds,
        avgTimeToPeakSeconds,
        entryTimingScore: null, momentumCaptureScore: null, lateEntryPct: null, missedOpportunityPct: null,
        deferredMetricsReason: "Entry Timing/Momentum Capture Score and Missed Opportunity % need a scoring design this sprint didn't resolve - deferred, not fabricated."
    };

}

// Section J (Open Position fields): SL/TP are the position's OWN stored
// risk bands (tradePlanService.buildRiskBands, computed once at real BUY
// time) - the exact values dynamicExitService.evaluateDynamicExit
// actually enforces, never a recomputed/current-config guess.
// dynamicState is a real, honest, coarse read of already-stored data
// (current ROI vs the same MIN_TP_PCT floor dynamicExitService itself
// uses) - "is this position still below its minimum target, or riding
// above it" - never a re-run of the momentum-sustained sub-checks
// (those are transient per-cycle signals, not meaningful to redisplay
// after the fact). priceUpdatedAt is real (migration 058); nextEvalAt is
// an ESTIMATE derived from it plus the user's own real
// scan_interval_seconds, explicitly labeled as such on the frontend -
// never a guarantee.
function getOpenPositions(userId){
    const config = tradingBotRepository.getConfig(userId);
    return tradingBotRepository.findOpenPositions(userId).map(p => {
        const roiPct = p.current_price != null ? ((p.current_price / p.entry_price) - 1) * 100 : null;
        const dynamicState = roiPct == null ? "AWAITING_PRICE_DATA" : (roiPct < MIN_TP_PCT ? "BELOW_TARGET" : "TRAILING_ABOVE_TARGET");
        const nextEvaluationAtEstimate = p.price_updated_at
            ? new Date(new Date(`${String(p.price_updated_at).replace(" ", "T")}Z`).getTime() + config.scan_interval_seconds * 1000).toISOString()
            : null;
        return {
            id: p.id,
            // Production Hotfix V1.1, Section 5: same real
            // execution_id-based signal as Trade History - a SIMULATION
            // position must never look indistinguishable from a real one.
            mode: p.execution_id != null ? "LIVE" : "SIMULATION",
            tokenAddress: p.token_address,
            tokenSymbol: p.token_symbol,
            entryPrice: p.entry_price,
            currentPrice: p.current_price,
            roiPct,
            stopLossPrice: p.stop_loss_price,
            targetPrice: p.target_price,
            dynamicState,
            priceUpdatedAt: p.price_updated_at,
            nextEvaluationAtEstimate,
            openedAt: p.opened_at,
            confidence: p.confidence,
            exitStrategy: p.exit_strategy,
            status: p.status
        };
    });
}

// Position-detail view (Trust/UX sprint): entirely real, already-
// persisted data - no re-scoring, no reconstruction. breakdown_json is
// only ever non-null for a position opened after migration 047's fix;
// older rows honestly report no breakdown rather than a fake one.
function getPositionDetail(userId, id){

    const position = tradingBotRepository.findPositionById(userId, id);
    if(!position) return null;

    let parsed = null;
    if(position.breakdown_json){
        try{ parsed = JSON.parse(position.breakdown_json); }
        catch(e){ /* malformed/legacy data - fall through to the honest "no breakdown" state below, never guess */ }
    }

    // Live Decision Center / Signal Center sprint: Strength/Weakness are
    // not a new derivation - `reasons` (participant/market modules'
    // positive signals) and the newly-exposed `riskReasons` (their
    // negative/risk signals) already ARE these two things; this just
    // gives them the honest, investor-facing names.
    const strength = parsed?.reasons ?? [];
    const weakness = parsed?.riskReasons ?? [];

    // Confidence Breakdown: False Positive Reduction V2, Priority 5 - a
    // position opened after this sprint carries its own real, fully-
    // computed confidenceBreakdown (mismatch/completeness/freshness/risk
    // penalties, researchEngineFactory.js's computeConfidence) straight
    // from breakdown_json, persisted at BUY time - preferred whenever
    // present. A position opened BEFORE this sprint has no such field;
    // for those, fall back to the original read-only re-derivation
    // (participantPct/marketPct/mismatchPenalty only - completeness/risk
    // penalties were never captured for legacy rows and are honestly left
    // out rather than guessed).
    let confidenceBreakdown = null;
    if(parsed?.confidenceBreakdown){
        const cb = parsed.confidenceBreakdown;
        confidenceBreakdown = {
            participantPct: parsed.participantMax ? Math.round((parsed.participantScore / parsed.participantMax) * 1000) / 10 : null,
            marketPct: parsed.marketHealthMax ? Math.round((parsed.marketHealth / parsed.marketHealthMax) * 1000) / 10 : null,
            mismatchPenalty: cb.mismatchPenalty ?? null,
            completenessPenalty: cb.completenessPenalty ?? null,
            freshnessPenalty: cb.freshnessPenalty ?? null,
            riskPenalty: cb.riskPenalty ?? null
        };
    }
    else if(parsed?.participantScore != null && parsed?.marketHealth != null && parsed?.participantMax && parsed?.marketHealthMax){
        const participantPct = parsed.participantScore / parsed.participantMax;
        const marketPct = parsed.marketHealth / parsed.marketHealthMax;
        const mismatch = Math.abs(participantPct - marketPct) * 100;
        const c = scoringConfig.confidence;
        confidenceBreakdown = {
            participantPct: Math.round(participantPct * 1000) / 10,
            marketPct: Math.round(marketPct * 1000) / 10,
            mismatchPenalty: Math.round(mismatch * c.mismatchPenaltyPerPoint * 100) / 100,
            freshnessPenalty: parsed.freshnessPenalty ?? null
        };
    }

    // Priority 5: "evidence yang tidak tersedia" and the final plain-
    // language pass reason, both persisted verbatim at BUY time - null/
    // empty (never guessed) for a position opened before this sprint.
    const missingEvidence = parsed?.missingEvidence ?? [];
    const passReason = parsed?.passReason ?? null;
    // Production Stabilization Final, Section G/H: the entry gate's own
    // real, persisted result - null for a position opened before this fix.
    const entryGateResult = parsed?.entryGateResult ?? null;
    // False Positive Reduction V4: real token age at entry - null for a
    // position opened before this fix, or when no real age data (neither
    // launch_time nor a trenches created_timestamp) existed for this token.
    const tokenAgeMinutesAtEntry = parsed?.tokenAgeMinutesAtEntry ?? null;
    // Production Stabilization V2 (Close Remaining BUY Blind Spots,
    // Section 5): the real, raw facts behind every score - null for a
    // position opened before this fix.
    const rawFactsAtEntry = parsed?.rawFactsAtEntry ?? null;

    // Flow: the acceleration signal's own flow-pace component (real
    // smart-money+KOL buy-rate data, researchEngineFactory.js's
    // computeAccelerationSignal) - null (never fabricated) for any profile
    // that doesn't compute acceleration, same honest fallback Position
    // Detail's acceleration display already uses.
    const flow = parsed?.acceleration?.flowAccel ?? null;
    const liquidity = parsed?.breakdown?.market?.liquidity ?? null;

    // Timeline (real trade row joined via migration 049's position_id FK -
    // null for a still-OPEN position, or one closed before that migration
    // existed, never guessed from token_address/opened_at instead).
    const trade = tradingBotRepository.findTradeByPositionId(userId, id);

    // Self-Comparison (Momentum Validation System sprint): real siblings
    // captured at buy time, each enriched on-demand with a real
    // comparative outcome - never a stored background job, never
    // fabricated for a position that has no real siblings_json.
    let siblings = [];
    if(position.siblings_json){
        try{ siblings = computeSiblingComparison(position, JSON.parse(position.siblings_json)); }
        catch(e){ /* malformed/legacy data - honest empty, never guessed */ }
    }

    return {
        id: position.id,
        tokenAddress: position.token_address,
        tokenSymbol: position.token_symbol,
        entryPrice: position.entry_price,
        currentPrice: position.current_price,
        roiPct: position.current_price != null ? ((position.current_price / position.entry_price) - 1) * 100 : null,
        sizeUsd: position.size_usd,
        confidence: position.confidence,
        exitStrategy: position.exit_strategy,
        targetPrice: position.target_price,
        stopLossPrice: position.stop_loss_price,
        mfePct: position.mfe_pct,
        maePct: position.mae_pct,
        status: position.status,
        risk: position.risk,
        rankAtEntry: position.rank_at_entry,
        priorityScoreAtEntry: position.priority_score_at_entry,
        breakdown: parsed?.breakdown ?? null,
        reasons: parsed?.reasons ?? [],
        acceleration: parsed?.acceleration ?? null,
        hasBreakdown: Boolean(parsed),
        strength,
        weakness,
        missingEvidence,
        passReason,
        entryGateResult,
        tokenAgeMinutesAtEntry,
        rawFactsAtEntry,
        confidenceBreakdown,
        flow,
        liquidity,
        siblings,
        // Timeline: BUY -> +5% -> +10% -> Highest/Reversal -> Lowest ->
        // Current -> Exit -> Sell. mfeAt/maeAt/crossed_Npct_at honestly
        // null ("not recorded") for any position opened/tracked before
        // the relevant migration added them - never a guessed timestamp.
        // "Reversal" is deliberately the SAME timestamp as "Highest" -
        // by construction, the last new peak IS the reversal-start
        // moment for whatever decline follows it, not a separate event.
        timeline: {
            buy: { at: position.opened_at, price: position.entry_price },
            crossed5pct: { at: position.crossed_5pct_at ?? null },
            crossed10pct: { at: position.crossed_10pct_at ?? null },
            highest: { pct: position.mfe_pct, at: position.mfe_at ?? null },
            reversal: { at: position.mfe_at ?? null },
            lowest: { pct: position.mae_pct, at: position.mae_at ?? null },
            current: position.status === "OPEN" ? { price: position.current_price } : null,
            exit: trade ? { price: trade.exit_price, reason: trade.reason } : null,
            sell: position.status === "CLOSED" ? { at: position.closed_at } : null
        }
    };

}

function getTrades(userId, limit){
    return tradingBotRepository.findRecentTrades(userId, limit).map(t => ({
        // Production Hotfix V1.1, Section 5: Trade History keeps showing
        // BOTH SIMULATION and LIVE rows (historical simulation data may
        // remain, per that sprint's own instruction) - but every row is
        // now clearly labeled, never blended unlabeled. close_execution_id
        // is the same real signal Production Stabilization V1 already
        // established distinguishes a genuine on-chain close from a
        // SIMULATION-mode paper trade.
        mode: t.close_execution_id != null ? "LIVE" : "SIMULATION",
        tokenSymbol: t.token_symbol,
        entryPrice: t.entry_price,
        exitPrice: t.exit_price,
        roiPct: t.roi_pct,
        // Section K (Trade History): real dollar PnL, not just ROI% - the
        // exact same net-of-fees formula sumClosedTrades() already uses
        // for the Portfolio's own realizedPnl, so the two can never drift.
        profitUsd: t.size_usd != null && t.roi_pct != null ? (t.size_usd * (t.roi_pct / 100)) - t.fee_usd : null,
        feeUsd: t.fee_usd,
        slippagePct: t.slippage_pct,
        durationSeconds: t.duration_seconds,
        reason: t.reason,
        engineVersion: t.engine_version,
        txHash: t.tx_hash,
        // Real explorer link when a real hash exists - historical NULL
        // rows (every trade before this sprint's fix) honestly stay
        // null, never backfilled/guessed.
        txExplorerUrl: buildSolanaTxUrl(t.tx_hash, envConfig.SOLANA_CLUSTER),
        openedAt: t.opened_at,
        closedAt: t.closed_at
    }));
}

function getLog(userId, limit){
    return tradingBotRepository.findRecentLog(userId, limit).map(l => ({
        type: l.log_type,
        tokenSymbol: l.token_symbol,
        message: l.message,
        meta: l.meta_json ? JSON.parse(l.meta_json) : null,
        at: l.created_at
    }));
}

// Sprint A Goal 1 ("prove consistent net profit under real conditions")
// artifact: a concrete, queryable "N days running, real equity curve,
// real max drawdown, net of fees" view - not a recomputed-per-call
// snapshot. running_since (migration 035) is set on the STOPPED/PAUSED
// -> RUNNING transition and survives pause/resume, unlike last_action_at.
function getEquityCurve(userId){
    const state = tradingBotRepository.getState(userId);
    return {
        runningSince: state.running_since,
        equityCurve: tradingBotRepository.findEquityCurve(userId),
        maxDrawdownPct: tradingBotRepository.computeMaxDrawdownPct(userId)
    };
}

// ---- CONTROL ACTIONS - flip real state, log a real event. No scan
// loop, no order placement - that is explicitly out of scope this
// phase ("Do NOT implement live trading yet").

// Onboarding Completion Check (product decision, following the User
// Journey v1 lock): Start Bot must never fail later because a
// prerequisite was silently missing - it's checked here, once, with a
// specific itemized reason, before the bot ever flips to RUNNING.
// Async as of Production Stabilization V1 (Sections D/E/Q) -
// onboardingService.getOnboardingStatus is now a real on-chain balance
// check (walletService.getRealWalletBalance). Its one caller (the start
// controller) is already an async Express handler.
async function startBot(userId){
    const state = tradingBotRepository.getState(userId);
    if(state.status === "RUNNING") return { ok: false, error: "Bot is already RUNNING." };

    // The full CRAB User Journey v1 checklist (owner wallet, deposit,
    // allocation, strategy) only protects REAL money - only enforced for
    // LIVE. SIMULATION has always been harmless paper trading and must
    // stay startable with zero setup, exactly as it worked before onboarding
    // existed - gating it the same as LIVE made Start Bot unstartable for
    // any account that hasn't been through the full real-money flow yet.
    if(state.mode === "LIVE"){
        const onboarding = await onboardingService.getOnboardingStatus(userId);
        if(!onboarding.readyToTrade){
            return { ok: false, error: `Complete onboarding before starting the bot in LIVE mode. Missing: ${onboarding.missing.join(", ")}.` };
        }
    }

    const updated = tradingBotRepository.updateState(userId, { status: "RUNNING", lastAction: "START" });
    const modeNote = state.mode === "LIVE" ? "LIVE mode - real GMGN execution" : "SIMULATION mode";
    tradingBotRepository.insertLog(userId, { logType: "SYSTEM", message: `Bot started (${modeNote}).` });
    return { ok: true, state: updated };
}

function stopBot(userId){
    const updated = tradingBotRepository.updateState(userId, { status: "STOPPED", lastAction: "STOP" });
    tradingBotRepository.insertLog(userId, { logType: "SYSTEM", message: "Bot stopped." });
    return { ok: true, state: updated };
}

// The missing wire between the dashboard and Founder Mode: nothing else
// in this file ever changes trading_bot_state.mode away from its
// SIMULATION default, so without this there was no way to ever reach
// LIVE through the product at all. Safe to expose to every account, not
// just the founder's - tradingBotEngine.js's own Founder Mode check
// (config.FOUNDER_WALLET_PUBLIC_KEY vs this user's trading wallet) is
// the real gate and is enforced independently, every cycle; this only
// changes what a user is ASKING for, never what they're authorized to
// get. Requires STOPPED so a mode flip can never happen mid-cycle.
function setMode(userId, mode){
    if(mode !== "SIMULATION" && mode !== "LIVE"){
        return { ok: false, error: "mode must be either SIMULATION or LIVE." };
    }
    const state = tradingBotRepository.getState(userId);
    if(state.status !== "STOPPED"){
        return { ok: false, error: "Stop the bot before switching mode." };
    }
    const updated = tradingBotRepository.updateState(userId, { status: state.status, mode, lastAction: `SET_MODE_${mode}` });
    tradingBotRepository.insertLog(userId, { logType: "SYSTEM", message: `Mode switched to ${mode}.` });
    return { ok: true, state: updated };
}

function pauseBot(userId){
    const state = tradingBotRepository.getState(userId);
    if(state.status !== "RUNNING") return { ok: false, error: "Bot is not RUNNING - nothing to pause." };
    const updated = tradingBotRepository.updateState(userId, { status: "PAUSED", lastAction: "PAUSE" });
    tradingBotRepository.insertLog(userId, { logType: "SYSTEM", message: "Bot paused." });
    return { ok: true, state: updated };
}

// Trust/UX sprint: the same "what price does a real closeIfDue see"
// source tradeManager.js's own closeIfDue uses (token feed price, then
// the position's own last-tracked price, then its entry price) - never a
// new/different price source for a user-triggered sell than the bot's
// own automatic one.
function currentPriceFor(position){
    const token = gmgnTokenRepository.getTokenByAddress(position.token_address);
    return (token && Number(token.price)) || position.current_price || position.entry_price;
}

// Was a no-op stub (logged "would be closed", never actually closed
// anything) - fixed to reuse the exact same tradeManager.finalizeClose()
// every automatic close already goes through, never a second close
// implementation. Sequential, not Promise.all: only one non-terminal
// execution per user is allowed at a time (executions table's own
// unique index, services/execution/executionService.js) - real LIVE
// sells for the same wallet must run one at a time.
async function forceSellAll(userId){

    const open = tradingBotRepository.findOpenPositions(userId);

    if(!open.length){
        tradingBotRepository.insertLog(userId, { logType: "SYSTEM", message: "Force Sell All requested - there are no open positions to close." });
        return { ok: true, positionsAffected: 0, positionsAttempted: 0 };
    }

    const state = tradingBotRepository.getState(userId);
    const config = tradingBotRepository.getConfig(userId);

    // Lazy require - tradingBotEngine.js already requires this file at
    // top level, so a top-level require here would be circular.
    const liveOptions = state.mode === "LIVE" ? require("./tradingBotEngine").buildLiveExecutionOptions(userId) : null;

    const tradeManagerForUser = tradeManager.createTradeManager(tradingBotRepository.forUser(userId), liveOptions);

    let closedCount = 0;
    for(const position of open){
        const result = await tradeManagerForUser.finalizeClose(position, currentPriceFor(position), "SELL_MANUAL", config);
        if(result.closed) closedCount++;
    }

    tradingBotRepository.insertLog(userId, {
        logType: "SYSTEM",
        message: `Force Sell All completed - ${closedCount} of ${open.length} open position(s) closed.`
    });

    return { ok: true, positionsAffected: closedCount, positionsAttempted: open.length };

}

// Real per-position manual sell (Trust/UX sprint) - reuses the exact
// same finalizeClose() path forceSellAll/the bot's own automatic close
// already use, scoped to exactly one position this user actually owns
// and still has open.
async function sellPosition(userId, positionId){

    const position = tradingBotRepository.findOpenPositionById(userId, positionId);
    if(!position) return { ok: false, status: 404, error: "Not found", details: "No open position with that id for this account." };

    const state = tradingBotRepository.getState(userId);
    const config = tradingBotRepository.getConfig(userId);

    const liveOptions = state.mode === "LIVE" ? require("./tradingBotEngine").buildLiveExecutionOptions(userId) : null;

    const tradeManagerForUser = tradeManager.createTradeManager(tradingBotRepository.forUser(userId), liveOptions);
    const result = await tradeManagerForUser.finalizeClose(position, currentPriceFor(position), "SELL_MANUAL", config);

    return {
        ok: true,
        closed: Boolean(result.closed),
        retrying: Boolean(result.retrying),
        reason: result.reason ?? null,
        roiPct: result.roiPct ?? null
    };

}

function emergencyStop(userId){
    const updated = tradingBotRepository.updateState(userId, { status: "STOPPED", lastAction: "EMERGENCY_STOP" });
    tradingBotRepository.insertLog(userId, { logType: "ERROR", message: "EMERGENCY STOP triggered - bot forced to STOPPED." });
    return { ok: true, state: updated };
}

// CRAB User Journey v1 (locked): Trading Allocation is a PERCENTAGE the
// user always thinks in, never a dollar amount they set directly.
// initial_capital (the one field the paper-trading engine actually
// reads - untouched by this change) is derived here and written
// alongside allocation_pct via tradingBotRepository.setAllocationAndCapital() -
// the ONLY place either field is ever written, same "owned by its own
// flow" convention as strategy_profile's bundle fields above.
//
// Production Stabilization V1 (Sections D/E/Q): the basis is now the
// REAL on-chain wallet balance (walletService.getRealWalletBalance),
// never the old self-reported deposited_balance_usd - a real deposit or
// withdrawal now flows through automatically (it's just a different
// on-chain balance the next real read sees), no app-side ledger action
// needed. Async because getRealWalletBalance is a real RPC/GMGN read -
// this function's one caller (the allocation controller) is already an
// async Express handler.
async function setAllocation(userId, allocationPct){
    const pct = Number(allocationPct);
    if(!Number.isFinite(pct) || pct < 0 || pct > 100){
        return { ok: false, error: "Trading Allocation must be a percentage between 0 and 100." };
    }
    const tradingWallet = tradingWalletRepository.findByUserId(userId);
    if(!tradingWallet){
        return { ok: false, error: "Generate a Trading Wallet before setting an allocation." };
    }
    const real = await walletService.getRealWalletBalance(userId);
    const initialCapital = computeInitialCapitalFromReal(real, pct);
    const config = tradingBotRepository.setAllocationAndCapital(userId, pct, initialCapital);
    return { ok: true, config };
}

// Reset Trading Capital (Founder-only action, implementation task
// following the CASH_EXHAUSTED_BEFORE_TURN root-cause investigation):
// a real wallet can accumulate realized losses until initial_capital +
// realizedPnl - openValueAtEntry (getPortfolio's own formula) sits
// below min_order_size forever, even though the real wallet still holds
// real, tradeable SOL - the AI keeps qualifying real BUY candidates that
// can never reach execution because the LEDGER, not the wallet, is
// exhausted. This does not "fix" that by changing the formula or
// switching to wallet-balance mode (explicitly rejected) - it gives the
// Founder an explicit, logged, ledger-only reset: same
// computeInitialCapitalFromReal(real, allocationPct) formula Trading
// Allocation already uses (never a second conversion), stamped via
// tradingBotRepository.resetLedgerBaseline() so getPortfolio() computes
// availableCash from realizedPnl since this moment only. Never touches
// trading_bot_positions/trading_bot_trades/executions/prediction_history/
// benchmark_* - no row in any of those tables is inserted, updated, or
// deleted by this function. Never starts/stops the bot, never touches
// mode/strategy/wallet - purely a trading_bot_config.initial_capital +
// ledger_reset_at write.
//
// Founder-only: same structural isFounderWallet gate
// getExecutorSnapshot()/tradingBotEngine.js's buildLiveExecutionOptions()
// already use (this user's trading wallet must equal the configured
// FOUNDER_WALLET_PUBLIC_KEY) - every other account is SIMULATION-only
// today and has no real wallet balance to reset against anyway.
async function resetTradingCapital(userId){

    const tradingWallet = tradingWalletRepository.findByUserId(userId);
    if(!tradingWallet){
        return { ok: false, error: "Generate a Trading Wallet before resetting Trading Capital." };
    }

    const isFounderWallet = Boolean(
        envConfig.FOUNDER_WALLET_PUBLIC_KEY && tradingWallet.public_key === envConfig.FOUNDER_WALLET_PUBLIC_KEY
    );
    if(!isFounderWallet){
        return { ok: false, error: "Reset Trading Capital is only available for the Founder Trading Wallet." };
    }

    const real = await walletService.getRealWalletBalance(userId);
    if(!real || real.solUsd == null){
        return { ok: false, error: `Could not read a real on-chain wallet balance${real?.unavailableReason ? ` (${real.unavailableReason})` : ""} - Reset Trading Capital needs a real balance to reset to, never a fabricated one.` };
    }

    const botConfig = tradingBotRepository.getConfig(userId);
    const previousInitialCapital = botConfig.initial_capital;
    const freshInitialCapital = computeInitialCapitalFromReal(real, botConfig.allocation_pct);

    const updated = tradingBotRepository.resetLedgerBaseline(userId, freshInitialCapital);

    tradingBotRepository.insertLog(userId, {
        logType: "SYSTEM",
        message: `Trading Capital reset - baseline changed from $${previousInitialCapital.toFixed(2)} to $${freshInitialCapital.toFixed(2)} (real wallet balance $${real.solUsd.toFixed(2)} x ${botConfig.allocation_pct}% Trading Allocation). Trade history and P&L history were not modified.`
    });

    return { ok: true, config: updated, walletBalanceUsd: real.solUsd, previousInitialCapital, freshInitialCapital };

}

module.exports = {
    getStatusBar, getConfig, updateConfig, getTradingConfiguration, updateTradingConfiguration,
    getPortfolio, getPortfolioReconciliation, getOpenPositions, getPositionDetail, getTrades, getLog, getEquityCurve,
    getDecisionCenter, getMomentumKpi, getMissedWinners, getSelfAudit, getSystemThroughput, getBottleneckReport, getTargetAchievementSummary,
    startBot, stopBot, pauseBot, forceSellAll, sellPosition, emergencyStop, setMode,
    analyzeCustomObjective, setAllocation, resetTradingCapital,
    // Production Stabilization V1 (Sections D/E/Q): exported purely for
    // scheduler/walletBalanceSyncScheduler.js's own periodic sync - the
    // one shared "real balance x allocation % -> Trading Balance" formula,
    // never a second copy of it.
    computeInitialCapitalFromReal
};
