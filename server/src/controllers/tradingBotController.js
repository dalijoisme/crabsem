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

async function getPortfolio(req, res, next){
    try{ sendSuccess(res, tradingBotService.getPortfolio(req.user.id)); }
    catch(err){ next(err); }
}

async function getPositions(req, res, next){
    try{ sendSuccess(res, tradingBotService.getOpenPositions(req.user.id)); }
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
        const result = tradingBotService.startBot(req.user.id);
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
    try{ sendSuccess(res, tradingBotService.forceSellAll(req.user.id)); }
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
        const result = tradingBotService.setAllocation(req.user.id, allocationPct);
        if(!result.ok) return sendError(res, 400, "Invalid allocation", result.error);
        sendSuccess(res, result.config);
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
    getStatus, getConfig, updateConfig,
    getPortfolio, getPositions, getTrades, getLog, getEquityCurve,
    start, stop, pause, forceSellAll, emergencyStop, setMode,
    analyzeCustomObjective, setAllocation
};
