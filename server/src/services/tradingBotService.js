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
const productionEngineResolver = require("../services/productionEngineResolver");
const strategyProfileConfig = require("../config/strategyProfileConfig");
const customObjectiveService = require("./customObjectiveService");
const onboardingService = require("./onboardingService");
// Named envConfig, not config - this file already uses `config` as the
// local variable name for trading_bot_config everywhere else.
const envConfig = require("../config/env");

// Constitution v1.0 / Final Spec section 02: these fields belong to the
// Strategy Profile bundle (config/strategyProfileConfig.js) - they are
// NEVER independently settable through the public API, only ever
// changed as a side effect of switching strategy_profile. Silently
// stripped from any incoming payload before it ever reaches the
// repository, whether or not this request also changes the profile.
const PROFILE_OWNED_FIELDS = [
    "min_confidence", "min_decay_fraction", "position_size_pct", "max_position_size",
    "max_open_positions", "cooldown_win_minutes", "cooldown_loss_minutes",
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
        Object.assign(sanitized, strategyProfileConfig.resolveProfile(partial.strategy_profile));
    }

    const updated = tradingBotRepository.updateConfig(userId, sanitized);

    // Onboarding's "Strategy selected" step requires a deliberate
    // choice, not the STABLE default every account already has -
    // stamped only when this request actually contains a real switch.
    if(partial.strategy_profile != null) tradingBotRepository.markStrategySelected(userId);

    tradingBotRepository.insertLog(userId, {
        logType: "SYSTEM",
        message: partial.strategy_profile != null
            ? `Bot configuration updated - Strategy Profile switched to ${partial.strategy_profile}.`
            : "Bot configuration updated."
    });
    return { ok: true, config: partial.strategy_profile != null ? tradingBotRepository.getConfig(userId) : updated };
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
    const closed = tradingBotRepository.sumClosedTrades(userId);
    const open = tradingBotRepository.sumOpenPositions(userId);

    const availableCash = config.initial_capital + closed.realizedPnl - open.openValueAtEntry;
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

function getOpenPositions(userId){
    return tradingBotRepository.findOpenPositions(userId).map(p => ({
        tokenAddress: p.token_address,
        tokenSymbol: p.token_symbol,
        entryPrice: p.entry_price,
        currentPrice: p.current_price,
        roiPct: p.current_price != null ? ((p.current_price / p.entry_price) - 1) * 100 : null,
        openedAt: p.opened_at,
        confidence: p.confidence,
        exitStrategy: p.exit_strategy,
        status: p.status
    }));
}

function getTrades(userId, limit){
    return tradingBotRepository.findRecentTrades(userId, limit).map(t => ({
        tokenSymbol: t.token_symbol,
        entryPrice: t.entry_price,
        exitPrice: t.exit_price,
        roiPct: t.roi_pct,
        feeUsd: t.fee_usd,
        slippagePct: t.slippage_pct,
        durationSeconds: t.duration_seconds,
        reason: t.reason,
        engineVersion: t.engine_version,
        txHash: t.tx_hash,
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
function startBot(userId){
    const state = tradingBotRepository.getState(userId);
    if(state.status === "RUNNING") return { ok: false, error: "Bot is already RUNNING." };

    // The full CRAB User Journey v1 checklist (owner wallet, deposit,
    // allocation, strategy) only protects REAL money - only enforced for
    // LIVE. SIMULATION has always been harmless paper trading and must
    // stay startable with zero setup, exactly as it worked before onboarding
    // existed - gating it the same as LIVE made Start Bot unstartable for
    // any account that hasn't been through the full real-money flow yet.
    if(state.mode === "LIVE"){
        const onboarding = onboardingService.getOnboardingStatus(userId);
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

function forceSellAll(userId){
    const open = tradingBotRepository.findOpenPositions(userId);
    tradingBotRepository.insertLog(userId, {
        logType: "SYSTEM",
        message: open.length
            ? `Force Sell All requested - ${open.length} open position(s) would be closed (no executor connected - no real order can be placed yet).`
            : "Force Sell All requested - there are no open positions to close."
    });
    return { ok: true, positionsAffected: open.length };
}

function emergencyStop(userId){
    const updated = tradingBotRepository.updateState(userId, { status: "STOPPED", lastAction: "EMERGENCY_STOP" });
    tradingBotRepository.insertLog(userId, { logType: "ERROR", message: "EMERGENCY STOP triggered - bot forced to STOPPED." });
    return { ok: true, state: updated };
}

// CRAB User Journey v1 (locked): Trading Allocation is a PERCENTAGE the
// user always thinks in, never a dollar amount they set directly.
// initial_capital (the one field the paper-trading engine actually
// reads - untouched by this change) is derived here as
// deposited_balance_usd * allocationPct / 100 and written alongside
// allocation_pct via tradingBotRepository.setAllocationAndCapital() -
// the ONLY place either field is ever written, same "owned by its own
// flow" convention as strategy_profile's bundle fields above. Because
// allocation is a percentage OF the deposit rather than an independent
// dollar figure, it can never become "invalid" relative to a shrunk
// deposit the way a stored dollar amount could - a later withdrawal
// just recomputes this same derived initial_capital down
// proportionally (see services/walletService.js's withdrawFunds()).
function setAllocation(userId, allocationPct){
    const pct = Number(allocationPct);
    if(!Number.isFinite(pct) || pct < 0 || pct > 100){
        return { ok: false, error: "Trading Allocation must be a percentage between 0 and 100." };
    }
    const tradingWallet = tradingWalletRepository.findByUserId(userId);
    if(!tradingWallet){
        return { ok: false, error: "Generate a Trading Wallet before setting an allocation." };
    }
    const initialCapital = tradingWallet.deposited_balance_usd * pct / 100;
    const config = tradingBotRepository.setAllocationAndCapital(userId, pct, initialCapital);
    return { ok: true, config };
}

module.exports = {
    getStatusBar, getConfig, updateConfig,
    getPortfolio, getOpenPositions, getTrades, getLog, getEquityCurve,
    startBot, stopBot, pauseBot, forceSellAll, emergencyStop, setMode,
    analyzeCustomObjective, setAllocation
};
