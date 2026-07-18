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

async function getSummary(req, res, next){

    try{ sendSuccess(res, predictionMetricsService.getSummary()); }
    catch(err){ next(err); }

}

async function getStrongBuy(req, res, next){

    try{ sendSuccess(res, predictionMetricsService.getStrongBuySummary()); }
    catch(err){ next(err); }

}

async function getHistory(req, res, next){

    try{

        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

        const offset = Math.max(0, Number(req.query.offset) || 0);

        sendSuccess(res, predictionMetricsService.getHistory({

            status: req.query.status || undefined,

            recommendation: req.query.recommendation || undefined,

            limit,

            offset

        }));

    }
    catch(err){ next(err); }

}

async function getStatistics(req, res, next){

    try{ sendSuccess(res, predictionMetricsService.getStatistics()); }
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
