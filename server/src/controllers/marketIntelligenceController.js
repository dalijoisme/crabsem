const marketIntelligenceService = require("../services/marketIntelligenceService");
const { validateLimit } = require("../utils/validators");
const { sendSuccess, sendError } = require("../utils/apiResponse");

async function getTrenches(req, res, next){

    try{

        const section = req.query.section;

        const limitCheck = validateLimit(req.query.limit, 30);

        if(!limitCheck.valid) return sendError(res, 400, "Invalid query parameters", limitCheck.error);

        const result = marketIntelligenceService.getTrenches(section, limitCheck.limit);

        sendSuccess(res, result);

    }
    catch(err){

        if(err.status === 400) return sendError(res, 400, "Invalid query parameters", err.message);

        next(err);

    }

}

async function getHotSearches(req, res, next){

    try{

        const chain = req.query.chain || "sol";

        const interval = req.query.interval || "24h";

        const limitCheck = validateLimit(req.query.limit, 50);

        if(!limitCheck.valid) return sendError(res, 400, "Invalid query parameters", limitCheck.error);

        const result = marketIntelligenceService.getHotSearches(chain, interval, limitCheck.limit);

        sendSuccess(res, result);

    }
    catch(err){

        next(err);

    }

}

async function getKolActivity(req, res, next){

    try{

        const limitCheck = validateLimit(req.query.limit, 50);

        if(!limitCheck.valid) return sendError(res, 400, "Invalid query parameters", limitCheck.error);

        sendSuccess(res, marketIntelligenceService.getActivityFeed("kol", limitCheck.limit));

    }
    catch(err){

        next(err);

    }

}

async function getSmartMoneyActivity(req, res, next){

    try{

        const limitCheck = validateLimit(req.query.limit, 50);

        if(!limitCheck.valid) return sendError(res, 400, "Invalid query parameters", limitCheck.error);

        sendSuccess(res, marketIntelligenceService.getActivityFeed("smart_money", limitCheck.limit));

    }
    catch(err){

        next(err);

    }

}

async function getGasPrice(req, res, next){

    try{

        const chain = req.query.chain || "sol";

        const result = marketIntelligenceService.getGasPrice(chain);

        if(!result) return sendError(res, 404, "No gas price data yet", `No snapshot collected for chain: ${chain}`);

        sendSuccess(res, result);

    }
    catch(err){

        next(err);

    }

}

async function getLaunchpadStats(req, res, next){

    try{

        sendSuccess(res, marketIntelligenceService.getLaunchpadStats());

    }
    catch(err){

        next(err);

    }

}

module.exports = { getTrenches, getHotSearches, getKolActivity, getSmartMoneyActivity, getGasPrice, getLaunchpadStats };
