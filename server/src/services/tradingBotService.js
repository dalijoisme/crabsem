// services/tradingBotService.js - Trading Bot Dashboard business logic.
// Monitoring/control only this phase - START/STOP/PAUSE only flip a
// real status flag; no scan loop, no order execution, no GMGN/wallet
// integration exists yet. Every number returned is either a real
// database value or an explicit empty/placeholder state - never a
// fabricated figure standing in for data that doesn't exist yet.
//
// Read-only with respect to Production_V1/Production_V2/Momentum
// Hunter/the prediction engine - this file only ever READS
// productionEngineResolver's registry for display purposes, never
// modifies engine code, config, or scoring in any way.

const db = require("../database/connection");
const tradingBotRepository = require("../repositories/tradingBotRepository");
const productionEngineResolver = require("../services/productionEngineResolver");

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

function deriveCapitalMode(config){
    if(config.position_size_pct >= 20) return "AGGRESSIVE";
    if(config.position_size_pct >= 10) return "BALANCED";
    return "CONSERVATIVE";
}

function getStatusBar(){
    const state = tradingBotRepository.getState();
    const config = tradingBotRepository.getConfig();
    const engine = getEngineSnapshot();

    return {
        tradingStatus: state.status,
        mode: state.mode,
        engine,
        executor: "GMGN",
        executorStatus: "Not Configured",
        gmgnStatus: "Disconnected",
        capitalMode: deriveCapitalMode(config),
        adaptiveExit: "Coming Soon"
    };
}

function getConfig(){
    return tradingBotRepository.getConfig();
}

function updateConfig(partial){
    const errors = [];
    if(partial.position_size_pct != null && (partial.position_size_pct <= 0 || partial.position_size_pct > 100)){
        errors.push("Position Size must be between 0 and 100%.");
    }
    if(partial.max_open_positions != null && partial.max_open_positions < 1){
        errors.push("Maximum Open Positions must be at least 1.");
    }
    if(partial.scan_interval_seconds != null && partial.scan_interval_seconds < 5){
        errors.push("Scan Interval must be at least 5 seconds.");
    }
    if(errors.length) return { ok: false, errors };

    const updated = tradingBotRepository.updateConfig(partial);
    tradingBotRepository.insertLog({ logType: "SYSTEM", message: "Bot configuration updated." });
    return { ok: true, config: updated };
}

// Every figure below is computed from real rows (currently empty, since
// no execution layer exists yet) - a fresh install genuinely shows
// Available Cash = Initial Capital and every other figure at its real,
// honest zero, not a placeholder pretending to be a live P&L.
function getPortfolio(){
    const config = tradingBotRepository.getConfig();
    const closed = tradingBotRepository.sumClosedTrades();
    const open = tradingBotRepository.sumOpenPositions();

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
        maxDrawdownPct: null // no real equity curve exists yet (zero trades) - honestly null, not 0%
    };
}

function getOpenPositions(){
    return tradingBotRepository.findOpenPositions().map(p => ({
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

function getTrades(limit){
    return tradingBotRepository.findRecentTrades(limit).map(t => ({
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

function getLog(limit){
    return tradingBotRepository.findRecentLog(limit).map(l => ({
        type: l.log_type,
        tokenSymbol: l.token_symbol,
        message: l.message,
        meta: l.meta_json ? JSON.parse(l.meta_json) : null,
        at: l.created_at
    }));
}

// ---- CONTROL ACTIONS - flip real state, log a real event. No scan
// loop, no order placement - that is explicitly out of scope this
// phase ("Do NOT implement live trading yet").

function startBot(){
    const state = tradingBotRepository.getState();
    if(state.status === "RUNNING") return { ok: false, error: "Bot is already RUNNING." };
    const updated = tradingBotRepository.updateState({ status: "RUNNING", lastAction: "START" });
    tradingBotRepository.insertLog({ logType: "SYSTEM", message: "Bot started (monitoring/control only - no execution layer connected yet)." });
    return { ok: true, state: updated };
}

function stopBot(){
    const updated = tradingBotRepository.updateState({ status: "STOPPED", lastAction: "STOP" });
    tradingBotRepository.insertLog({ logType: "SYSTEM", message: "Bot stopped." });
    return { ok: true, state: updated };
}

function pauseBot(){
    const state = tradingBotRepository.getState();
    if(state.status !== "RUNNING") return { ok: false, error: "Bot is not RUNNING - nothing to pause." };
    const updated = tradingBotRepository.updateState({ status: "PAUSED", lastAction: "PAUSE" });
    tradingBotRepository.insertLog({ logType: "SYSTEM", message: "Bot paused." });
    return { ok: true, state: updated };
}

function forceSellAll(){
    const open = tradingBotRepository.findOpenPositions();
    tradingBotRepository.insertLog({
        logType: "SYSTEM",
        message: open.length
            ? `Force Sell All requested - ${open.length} open position(s) would be closed (no executor connected - no real order can be placed yet).`
            : "Force Sell All requested - there are no open positions to close."
    });
    return { ok: true, positionsAffected: open.length };
}

function emergencyStop(){
    const updated = tradingBotRepository.updateState({ status: "STOPPED", lastAction: "EMERGENCY_STOP" });
    tradingBotRepository.insertLog({ logType: "ERROR", message: "EMERGENCY STOP triggered - bot forced to STOPPED." });
    return { ok: true, state: updated };
}

module.exports = {
    getStatusBar, getConfig, updateConfig,
    getPortfolio, getOpenPositions, getTrades, getLog,
    startBot, stopBot, pauseBot, forceSellAll, emergencyStop
};
