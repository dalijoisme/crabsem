// controllers/adminController.js - thin HTTP layer for the Admin
// Panel. Every route here is gated by middleware/adminAuth.js at the
// router level (see routes/v1/admin.js) - no per-handler auth checks.

const adminService = require("../services/adminService");
const { sendSuccess, sendError } = require("../utils/apiResponse");

function isValidAddress(address){

    return typeof address === "string" && address.trim().length >= 10 && address.trim().length <= 100;

}

async function getSystem(req, res, next){

    try{ sendSuccess(res, adminService.getSystem()); }
    catch(err){ next(err); }

}

async function getWalletsSummary(req, res, next){

    try{ sendSuccess(res, adminService.getWalletsSummary()); }
    catch(err){ next(err); }

}

async function getEngineConfig(req, res, next){

    try{ sendSuccess(res, adminService.getEngineConfig()); }
    catch(err){ next(err); }

}

async function getPredictionSummary(req, res, next){

    try{ sendSuccess(res, adminService.getPredictionSummary()); }
    catch(err){ next(err); }

}

async function refreshToken(req, res, next){

    try{

        const address = (req.params.address || "").trim();

        if(!isValidAddress(address)) return sendError(res, 400, "Invalid address");

        sendSuccess(res, await adminService.refreshToken(address));

    }
    catch(err){ next(err); }

}

async function reanalyzeToken(req, res, next){

    try{

        const address = (req.params.address || "").trim();

        if(!isValidAddress(address)) return sendError(res, 400, "Invalid address");

        const result = adminService.reanalyzeToken(address);

        if(!result) return sendError(res, 404, "Token not found");

        sendSuccess(res, result);

    }
    catch(err){ next(err); }

}

async function deleteTokenCache(req, res, next){

    try{

        const address = (req.params.address || "").trim();

        if(!isValidAddress(address)) return sendError(res, 400, "Invalid address");

        sendSuccess(res, adminService.deleteTokenCache(address));

    }
    catch(err){ next(err); }

}

module.exports = {

    getSystem,

    getWalletsSummary,

    getEngineConfig,

    getPredictionSummary,

    refreshToken,

    reanalyzeToken,

    deleteTokenCache

};
