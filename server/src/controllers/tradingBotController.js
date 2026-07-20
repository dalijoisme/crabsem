// controllers/tradingBotController.js - thin HTTP layer for the Trading
// Bot Dashboard. No business logic here - see services/tradingBotService.js.

const tradingBotService = require("../services/tradingBotService");
const { sendSuccess, sendError } = require("../utils/apiResponse");

async function getStatus(req, res, next){
    try{ sendSuccess(res, tradingBotService.getStatusBar()); }
    catch(err){ next(err); }
}

async function getConfig(req, res, next){
    try{ sendSuccess(res, tradingBotService.getConfig()); }
    catch(err){ next(err); }
}

async function updateConfig(req, res, next){
    try{
        const result = tradingBotService.updateConfig(req.body || {});
        if(!result.ok) return sendError(res, 400, "Invalid configuration", result.errors.join(" "));
        sendSuccess(res, result.config);
    }
    catch(err){ next(err); }
}

async function getPortfolio(req, res, next){
    try{ sendSuccess(res, tradingBotService.getPortfolio()); }
    catch(err){ next(err); }
}

async function getPositions(req, res, next){
    try{ sendSuccess(res, tradingBotService.getOpenPositions()); }
    catch(err){ next(err); }
}

async function getTrades(req, res, next){
    try{ sendSuccess(res, tradingBotService.getTrades(Number(req.query.limit) || 100)); }
    catch(err){ next(err); }
}

async function getLog(req, res, next){
    try{ sendSuccess(res, tradingBotService.getLog(Number(req.query.limit) || 100)); }
    catch(err){ next(err); }
}

async function start(req, res, next){
    try{
        const result = tradingBotService.startBot();
        if(!result.ok) return sendError(res, 409, "Cannot start", result.error);
        sendSuccess(res, result.state);
    }
    catch(err){ next(err); }
}

async function stop(req, res, next){
    try{ sendSuccess(res, tradingBotService.stopBot().state); }
    catch(err){ next(err); }
}

async function pause(req, res, next){
    try{
        const result = tradingBotService.pauseBot();
        if(!result.ok) return sendError(res, 409, "Cannot pause", result.error);
        sendSuccess(res, result.state);
    }
    catch(err){ next(err); }
}

async function forceSellAll(req, res, next){
    try{ sendSuccess(res, tradingBotService.forceSellAll()); }
    catch(err){ next(err); }
}

async function emergencyStop(req, res, next){
    try{ sendSuccess(res, tradingBotService.emergencyStop().state); }
    catch(err){ next(err); }
}

module.exports = {
    getStatus, getConfig, updateConfig,
    getPortfolio, getPositions, getTrades, getLog,
    start, stop, pause, forceSellAll, emergencyStop
};
