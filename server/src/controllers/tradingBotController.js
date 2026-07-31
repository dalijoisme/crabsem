// controllers/tradingBotController.js - thin HTTP layer for the Trading
// Bot Dashboard. No business logic here - see services/tradingBotService.js.
//
// Sprint A, Goal 2 (auth/multi-tenancy foundation): every handler reads
// req.user.id (attached by middleware/userAuth.js - see routes/v1/tradingBot.js)
// and passes it first into the matching service call, so every
// dashboard action operates on THIS caller's own bot, never a global one.

const tradingBotService = require("../services/tradingBotService");
const { sendSuccess, sendError } = require("../utils/apiResponse");

async function getStatus(req, res, next){
    try{ sendSuccess(res, tradingBotService.getStatusBar(req.user.id)); }
    catch(err){ next(err); }
}

async function getConfig(req, res, next){
    try{ sendSuccess(res, tradingBotService.getConfig(req.user.id)); }
    catch(err){ next(err); }
}

async function updateConfig(req, res, next){
    try{
        const result = tradingBotService.updateConfig(req.user.id, req.body || {});
        if(!result.ok) return sendError(res, 400, "Invalid configuration", result.errors.join(" "));
        sendSuccess(res, result.config);
    }
    catch(err){ next(err); }
}

// Trading Configuration sprint - real wallet/trading/reserved/available
// balances + current sizing config, independent of Strategy Profile.
async function getTradingConfiguration(req, res, next){
    try{ sendSuccess(res, await tradingBotService.getTradingConfiguration(req.user.id)); }
    catch(err){ next(err); }
}

async function updateTradingConfiguration(req, res, next){
    try{
        const result = tradingBotService.updateTradingConfiguration(req.user.id, req.body || {});
        if(!result.ok) return sendError(res, 400, "Invalid Trading Configuration", result.errors.join(" "));
        sendSuccess(res, result.config);
    }
    catch(err){ next(err); }
}

async function getPortfolio(req, res, next){
    try{ sendSuccess(res, await tradingBotService.getPortfolioReconciliation(req.user.id)); }
    catch(err){ next(err); }
}

async function getPositions(req, res, next){
    try{ sendSuccess(res, tradingBotService.getOpenPositions(req.user.id)); }
    catch(err){ next(err); }
}

// Position-detail view (Trust/UX sprint) - works for OPEN or CLOSED
// positions, scoped to the caller's own account.
async function getPositionDetail(req, res, next){
    try{
        const detail = tradingBotService.getPositionDetail(req.user.id, Number(req.params.id));
        if(!detail) return sendError(res, 404, "Not found", "No position with that id for this account.");
        sendSuccess(res, detail);
    }
    catch(err){ next(err); }
}

// Live Decision Center - the dashboard's new home view.
async function getDecisionCenter(req, res, next){
    try{ sendSuccess(res, await tradingBotService.getDecisionCenter(req.user.id)); }
    catch(err){ next(err); }
}

// Momentum KPI sprint - see services/tradingBotService.js's own header
// comment on getMomentumKpi for exactly which fields are real vs. an
// honest, explicitly-deferred null.
async function getMomentumKpi(req, res, next){
    try{ sendSuccess(res, tradingBotService.getMomentumKpi(req.user.id)); }
    catch(err){ next(err); }
}

// Missed Winners page (Momentum Validation System sprint) - real,
// settled outcomes only.
async function getMissedWinners(req, res, next){
    try{ sendSuccess(res, tradingBotService.getMissedWinners(req.user.id, Number(req.query.limit) || 50)); }
    catch(err){ next(err); }
}

// Self-Audit / Performance Report (Momentum Validation System sprint) -
// rolling window, defaults to the sprint's own mandated 24h.
async function getSelfAudit(req, res, next){
    try{ sendSuccess(res, tradingBotService.getSelfAudit(req.user.id, Number(req.query.hours) || 24)); }
    catch(err){ next(err); }
}

// System Throughput (Phase 2: Live Validation & Bottleneck Elimination) -
// rolling window, defaults to 24h.
async function getSystemThroughput(req, res, next){
    try{ sendSuccess(res, tradingBotService.getSystemThroughput(req.user.id, Number(req.query.hours) || 24)); }
    catch(err){ next(err); }
}

// Bottleneck Report (Phase 2) - rolling window, defaults to 24h.
async function getBottleneckReport(req, res, next){
    try{ sendSuccess(res, tradingBotService.getBottleneckReport(req.user.id, Number(req.query.hours) || 24)); }
    catch(err){ next(err); }
}

// Target Achievement summary (Phase 2's own explicit deliverable).
async function getTargetAchievementSummary(req, res, next){
    try{ sendSuccess(res, tradingBotService.getTargetAchievementSummary(req.user.id, Number(req.query.hours) || 24)); }
    catch(err){ next(err); }
}

async function getTrades(req, res, next){
    try{ sendSuccess(res, tradingBotService.getTrades(req.user.id, Number(req.query.limit) || 100)); }
    catch(err){ next(err); }
}

async function getLog(req, res, next){
    try{ sendSuccess(res, tradingBotService.getLog(req.user.id, Number(req.query.limit) || 100)); }
    catch(err){ next(err); }
}

// Sprint A Goal 1 ("prove consistent net profit under real conditions")
// artifact - see services/tradingBotService.js's getEquityCurve().
async function getEquityCurve(req, res, next){
    try{ sendSuccess(res, tradingBotService.getEquityCurve(req.user.id)); }
    catch(err){ next(err); }
}

async function start(req, res, next){
    try{
        const result = await tradingBotService.startBot(req.user.id);
        if(!result.ok) return sendError(res, 409, "Cannot start", result.error);
        sendSuccess(res, result.state);
    }
    catch(err){ next(err); }
}

async function stop(req, res, next){
    try{ sendSuccess(res, tradingBotService.stopBot(req.user.id).state); }
    catch(err){ next(err); }
}

async function pause(req, res, next){
    try{
        const result = tradingBotService.pauseBot(req.user.id);
        if(!result.ok) return sendError(res, 409, "Cannot pause", result.error);
        sendSuccess(res, result.state);
    }
    catch(err){ next(err); }
}

async function setMode(req, res, next){
    try{
        const result = tradingBotService.setMode(req.user.id, req.body?.mode);
        if(!result.ok) return sendError(res, 409, "Cannot switch mode", result.error);
        sendSuccess(res, result.state);
    }
    catch(err){ next(err); }
}

async function forceSellAll(req, res, next){
    try{ sendSuccess(res, await tradingBotService.forceSellAll(req.user.id)); }
    catch(err){ next(err); }
}

// Trust/UX sprint - the per-position counterpart to forceSellAll, both
// backed by the exact same tradeManager.finalizeClose() path.
async function sellPosition(req, res, next){
    try{
        const result = await tradingBotService.sellPosition(req.user.id, Number(req.params.id));
        if(!result.ok) return sendError(res, result.status || 400, result.error || "Cannot sell", result.details);
        sendSuccess(res, result);
    }
    catch(err){ next(err); }
}

async function emergencyStop(req, res, next){
    try{ sendSuccess(res, tradingBotService.emergencyStop(req.user.id).state); }
    catch(err){ next(err); }
}

// CRAB User Journey v1 (locked) - Trading Allocation is a percentage,
// never a dollar amount the user sets directly. requireVerifiedEmail
// (Phase 4) will gate this route once it exists - not wired yet.
async function setAllocation(req, res, next){
    try{
        const { allocationPct } = req.body || {};
        const result = await tradingBotService.setAllocation(req.user.id, allocationPct);
        if(!result.ok) return sendError(res, 400, "Invalid allocation", result.error);
        sendSuccess(res, result.config);
    }
    catch(err){ next(err); }
}

// Reset Trading Capital (Founder-only) - services/tradingBotService.js's
// resetTradingCapital() already fails closed (403-shaped ok:false) for
// any wallet that isn't the configured Founder Trading Wallet, and for
// a real balance read that isn't available - a 400 here just means the
// action couldn't run yet, never a partial/silent success.
async function resetTradingCapital(req, res, next){
    try{
        const result = await tradingBotService.resetTradingCapital(req.user.id);
        if(!result.ok) return sendError(res, 400, "Cannot reset Trading Capital", result.error);
        sendSuccess(res, result);
    }
    catch(err){ next(err); }
}

// Custom Objective AI Advisor (Constitution clause 7) - stateless, no
// side effects, not scoped to any user's bot. Never starts the bot
// itself; the frontend calls PUT /config then POST /start separately,
// only after the user reviews this analysis and explicitly approves.
async function analyzeCustomObjective(req, res, next){
    try{
        const result = tradingBotService.analyzeCustomObjective(req.body || {});
        if(!result.ok) return sendError(res, 400, "Invalid input", result.errors.join(" "));
        sendSuccess(res, result.result);
    }
    catch(err){ next(err); }
}

module.exports = {
    getStatus, getConfig, updateConfig, getTradingConfiguration, updateTradingConfiguration,
    getPortfolio, getPositions, getPositionDetail, getTrades, getLog, getEquityCurve, getDecisionCenter, getMomentumKpi, getMissedWinners, getSelfAudit, getSystemThroughput, getBottleneckReport, getTargetAchievementSummary,
    start, stop, pause, forceSellAll, sellPosition, emergencyStop, setMode,
    analyzeCustomObjective, setAllocation, resetTradingCapital
};
