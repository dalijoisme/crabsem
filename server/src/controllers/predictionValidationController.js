// controllers/predictionValidationController.js - thin HTTP layer for
// the AI Validation Framework's read endpoints (engine-quality sprint
// 3, Part 5). Mounted at /api/v1/validation/predictions/* - see
// routes/v1/predictionValidation.js for why this is namespaced under
// /predictions rather than colliding with the pre-existing
// /api/v1/validation/summary (Sprint 2's recommendation_log-based
// framework, still intact and unrelated to this one).

const predictionMetricsService = require("../services/predictionMetricsService");
const predictionHistoryRepository = require("../repositories/predictionHistoryRepository");
const { sendSuccess, sendError } = require("../utils/apiResponse");

// Admin Date Filter (UX sprint, Part 2) - `from`/`to` are real
// "YYYY-MM-DD" calendar dates, validated here once so every endpoint
// below shares the exact same real-vs-malformed check. Omitting
// either means "All Time" on that side of the range - never guessed,
// never defaulted to a fabricated date.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateRange(query){

    const from = query.from;

    const to = query.to;

    if(from !== undefined && !DATE_RE.test(from)) return { valid: false, error: "from must be YYYY-MM-DD" };

    if(to !== undefined && !DATE_RE.test(to)) return { valid: false, error: "to must be YYYY-MM-DD" };

    return { valid: true, from: from || undefined, to: to || undefined };

}

async function getSummary(req, res, next){

    try{

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        sendSuccess(res, predictionMetricsService.getSummary(range));

    }
    catch(err){ next(err); }

}

async function getStrongBuy(req, res, next){

    try{

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        sendSuccess(res, predictionMetricsService.getStrongBuySummary(range));

    }
    catch(err){ next(err); }

}

async function getHistory(req, res, next){

    try{

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

        const offset = Math.max(0, Number(req.query.offset) || 0);

        sendSuccess(res, predictionMetricsService.getHistory({

            status: req.query.status || undefined,

            recommendation: req.query.recommendation || undefined,

            from: range.from,

            to: range.to,

            limit,

            offset

        }));

    }
    catch(err){ next(err); }

}

async function getStatistics(req, res, next){

    try{

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        sendSuccess(res, predictionMetricsService.getStatistics(range));

    }
    catch(err){ next(err); }

}

// Bonus (beyond the literal 4-endpoint spec) - single prediction with
// its real timeline attached, since prediction_timeline (Part 8) has
// no other way to be read back through the API otherwise.

async function getOne(req, res, next){

    try{

        const id = Number(req.params.id);

        if(!Number.isInteger(id)) return sendError(res, 400, "Invalid prediction id");

        const prediction = predictionHistoryRepository.findById(id);

        if(!prediction) return sendError(res, 404, "Prediction not found");

        const timeline = predictionMetricsService.getTimeline(id);

        sendSuccess(res, { prediction, timeline });

    }
    catch(err){ next(err); }

}

module.exports = { getSummary, getStrongBuy, getHistory, getStatistics, getOne };
