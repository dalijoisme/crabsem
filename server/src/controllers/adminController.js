// controllers/adminController.js - thin HTTP layer for the Admin
// Panel. Every route here is gated by middleware/adminAuth.js at the
// router level (see routes/v1/admin.js) - no per-handler auth checks.

const adminService = require("../services/adminService");
const adminAuthService = require("../services/adminAuthService");
const gmgnTrafficAccounting = require("../collectors/gmgn/gmgnTrafficAccounting");
const { sendSuccess, sendError } = require("../utils/apiResponse");

function isValidAddress(address){

    return typeof address === "string" && address.trim().length >= 10 && address.trim().length <= 100;

}

// POST /admin/login - the only admin route NOT gated by adminAuth
// middleware (see routes/v1/admin.js) - you need to log in before you
// can have a token to be gated by. Real password check against
// process.env.ADMIN_PASSWORD (see config/env.js), never hardcoded.

async function login(req, res, next){

    try{

        const password = req.body?.password;

        const result = adminAuthService.login(password);

        if(!result.ok) return sendError(res, result.status, result.error, result.details);

        sendSuccess(res, { token: result.token });

    }
    catch(err){ next(err); }

}

async function getDashboard(req, res, next){

    try{ sendSuccess(res, adminService.getDashboard()); }
    catch(err){ next(err); }

}

async function getSystem(req, res, next){

    try{ sendSuccess(res, adminService.getSystem()); }
    catch(err){ next(err); }

}

async function getWalletsSummary(req, res, next){

    try{ sendSuccess(res, adminService.getWalletsSummary()); }
    catch(err){ next(err); }

}

// Arjuna V4 Phase 2 (Daily Trading Review infrastructure) - ?date=YYYY-MM-DD
// optional, omitted defaults to the most recently generated real review.
// A day that was never reviewed returns success with data:null (never a
// fabricated report, never a 404 - "no review exists yet" is a real,
// valid state e.g. before this sprint's first full day in production).
async function getDailyReview(req, res, next){

    try{ sendSuccess(res, adminService.getDailyReview(req.query.date)); }
    catch(err){ next(err); }

}

async function getDailyReviewRecent(req, res, next){

    try{ sendSuccess(res, adminService.getDailyReviewRecent(Number(req.query.limit) || undefined)); }
    catch(err){ next(err); }

}

async function getEngineConfig(req, res, next){

    try{ sendSuccess(res, adminService.getEngineConfig()); }
    catch(err){ next(err); }

}

// RATE_LIMIT_BANNED investigation, round 2 - real, measured GMGN
// traffic accounting, real-time from this process's own in-memory
// record (see collectors/gmgn/gmgnTrafficAccounting.js). windowMs is
// optional (?windowMs=600000 for the last 10 minutes, matching the real
// ban-observation window) - defaults to the module's own full retention
// (30 minutes).
async function getGmgnTrafficAccounting(req, res, next){

    try{

        const windowMs = req.query.windowMs ? Number(req.query.windowMs) : undefined;
        sendSuccess(res, gmgnTrafficAccounting.getTrafficAccounting(windowMs));

    }
    catch(err){ next(err); }

}

async function getPredictionSummary(req, res, next){

    try{ sendSuccess(res, adminService.getPredictionSummary()); }
    catch(err){ next(err); }

}

async function getPredictionThroughput(req, res, next){

    try{ sendSuccess(res, adminService.getPredictionThroughput()); }
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

    login,

    getDashboard,

    getSystem,

    getWalletsSummary,

    getDailyReview,

    getDailyReviewRecent,

    getEngineConfig,

    getGmgnTrafficAccounting,

    getPredictionSummary,

    getPredictionThroughput,

    refreshToken,

    reanalyzeToken,

    deleteTokenCache

};
