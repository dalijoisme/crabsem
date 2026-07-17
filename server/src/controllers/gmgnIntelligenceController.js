// controllers/gmgnIntelligenceController.js - on-demand per-token /
// per-wallet GMGN lookups. Thin HTTP layer only - all fetching/
// caching logic lives in services/gmgnOndemandService.js.

const gmgnOndemandService = require("../services/gmgnOndemandService");
const { sendSuccess, sendError } = require("../utils/apiResponse");

function isValidAddress(address){

    return typeof address === "string" && address.trim().length >= 10 && address.trim().length <= 100;

}

function chainOf(req){

    return req.query.chain || "sol";

}

async function withAddress(req, res, next, handler){

    try{

        const address = (req.params.address || "").trim();

        if(!isValidAddress(address)){

            return sendError(res, 400, "Invalid address", "address must be a non-empty string between 10 and 100 characters");

        }

        const result = await handler(chainOf(req), address);

        sendSuccess(res, result);

    }
    catch(err){

        if(err.status) return sendError(res, err.status, err.message, "");

        next(err);

    }

}

// ---- Token ----

async function getTokenSecurity(req, res, next){

    await withAddress(req, res, next, gmgnOndemandService.getTokenSecurity);

}

async function getTokenPoolInfo(req, res, next){

    await withAddress(req, res, next, gmgnOndemandService.getTokenPoolInfo);

}

async function getTokenTopHolders(req, res, next){

    await withAddress(req, res, next, gmgnOndemandService.getTokenTopHolders);

}

async function getTokenTopTraders(req, res, next){

    await withAddress(req, res, next, gmgnOndemandService.getTokenTopTraders);

}

async function getTokenKline(req, res, next){

    try{

        const address = (req.params.address || "").trim();

        if(!isValidAddress(address)){

            return sendError(res, 400, "Invalid address", "address must be a non-empty string between 10 and 100 characters");

        }

        const resolution = req.query.resolution || "1h";

        const result = await gmgnOndemandService.getTokenKline(chainOf(req), address, resolution);

        sendSuccess(res, result);

    }
    catch(err){

        if(err.status) return sendError(res, err.status, err.message, "");

        next(err);

    }

}

// ---- Wallet ----

async function getWalletActivity(req, res, next){

    await withAddress(req, res, next, gmgnOndemandService.getWalletActivity);

}

async function getWalletStats(req, res, next){

    await withAddress(req, res, next, gmgnOndemandService.getWalletStats);

}

async function getWalletHoldings(req, res, next){

    await withAddress(req, res, next, gmgnOndemandService.getWalletHoldings);

}

async function getCreatedTokens(req, res, next){

    await withAddress(req, res, next, gmgnOndemandService.getCreatedTokens);

}

async function getWalletTokenBalance(req, res, next){

    try{

        const address = (req.params.address || "").trim();

        const tokenAddress = (req.params.tokenAddress || "").trim();

        if(!isValidAddress(address) || !isValidAddress(tokenAddress)){

            return sendError(res, 400, "Invalid address", "wallet address and token address must both be non-empty strings between 10 and 100 characters");

        }

        const result = await gmgnOndemandService.getWalletTokenBalance(chainOf(req), address, tokenAddress);

        sendSuccess(res, result);

    }
    catch(err){

        if(err.status) return sendError(res, err.status, err.message, "");

        next(err);

    }

}

module.exports = {

    getTokenSecurity,

    getTokenPoolInfo,

    getTokenTopHolders,

    getTokenTopTraders,

    getTokenKline,

    getWalletActivity,

    getWalletStats,

    getWalletHoldings,

    getCreatedTokens,

    getWalletTokenBalance

};
