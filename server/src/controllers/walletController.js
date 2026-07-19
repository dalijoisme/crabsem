const walletQueryService = require("../services/walletQueryService");
const { validateLimit } = require("../utils/validators");
const { sendSuccess, sendError } = require("../utils/apiResponse");

function toNumberOrUndefined(v){

    if(v === undefined || v === "") return undefined;

    const n = Number(v);

    return Number.isFinite(n) ? n : undefined;

}

// Admin Date Filter (UX sprint, Part 2) - filters wallet leaderboard/
// search by the wallet's own real last_seen field (see
// walletRepository.search()'s doc comment for the honest limitation:
// this is "active in range", not a true historical point-in-time
// ranking). Same "YYYY-MM-DD" validation as
// predictionValidationController.js's date filter.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateRange(query){

    const from = query.from;

    const to = query.to;

    if(from !== undefined && !DATE_RE.test(from)) return { valid: false, error: "from must be YYYY-MM-DD" };

    if(to !== undefined && !DATE_RE.test(to)) return { valid: false, error: "to must be YYYY-MM-DD" };

    return { valid: true, from: from || undefined, to: to || undefined };

}

// Wallet Search Engine - real filters over real computed stats, e.g.
// "win rate > 90%", "ROI > 500%", "wallets similar to X" (via the
// dedicated /wallets/:address/similar route below).

async function search(req, res, next){

    try{

        const limitCheck = validateLimit(req.query.limit, 50);

        if(!limitCheck.valid) return sendError(res, 400, "Invalid query parameters", limitCheck.error);

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        const minWinRatePct = toNumberOrUndefined(req.query.minWinRate);

        const minRoi = toNumberOrUndefined(req.query.minRoi);

        const minTrades = toNumberOrUndefined(req.query.minTrades);

        const result = walletQueryService.search({

            minWinRate: minWinRatePct != null ? minWinRatePct / 100 : undefined,

            minRoi,

            minTrades,

            label: req.query.label || undefined,

            q: req.query.q || undefined,

            from: range.from,

            to: range.to,

            limit: limitCheck.limit,

            sortColumn: req.query.sort,

            direction: req.query.direction

        });

        sendSuccess(res, result);

    }
    catch(err){

        next(err);

    }

}

async function leaderboard(req, res, next){

    try{

        const limitCheck = validateLimit(req.query.limit, 50);

        if(!limitCheck.valid) return sendError(res, 400, "Invalid query parameters", limitCheck.error);

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        const wallets = walletQueryService.leaderboard({ limit: limitCheck.limit, sortColumn: req.query.sort || "score", direction: req.query.direction, q: req.query.q || undefined, from: range.from, to: range.to });

        sendSuccess(res, { wallets });

    }
    catch(err){

        next(err);

    }

}

async function getProfile(req, res, next){

    try{

        const profile = walletQueryService.getProfile(req.params.address);

        if(!profile) return sendError(res, 404, "Wallet not found", `No tracked wallet at ${req.params.address}`);

        sendSuccess(res, profile);

    }
    catch(err){

        next(err);

    }

}

module.exports = { search, leaderboard, getProfile };
