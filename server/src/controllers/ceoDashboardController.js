// controllers/ceoDashboardController.js - thin HTTP layer for the
// CEO Dashboard (Admin Dashboard V2). Every route is gated by
// adminAuth at the router level - see routes/v1/admin.js.

const ceoDashboardService = require("../services/ceoDashboardService");
const predictionMetricsService = require("../services/predictionMetricsService");
const exportBuilder = require("../utils/exportBuilder");
const { sendSuccess, sendError } = require("../utils/apiResponse");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateRange(query){

    const from = query.from;

    const to = query.to;

    if(from !== undefined && !DATE_RE.test(from)) return { valid: false, error: "from must be YYYY-MM-DD" };

    if(to !== undefined && !DATE_RE.test(to)) return { valid: false, error: "to must be YYYY-MM-DD" };

    return { valid: true, from: from || undefined, to: to || undefined };

}

async function getEngineStatus(req, res, next){

    try{ sendSuccess(res, ceoDashboardService.getEngineStatus()); }
    catch(err){ next(err); }

}

async function getSignalSummary(req, res, next){

    try{

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        sendSuccess(res, ceoDashboardService.getSignalSummary(range));

    }
    catch(err){ next(err); }

}

async function getResultSummary(req, res, next){

    try{

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        sendSuccess(res, predictionMetricsService.getSummary(range));

    }
    catch(err){ next(err); }

}

async function getStrongBuyAnalysis(req, res, next){

    try{

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        sendSuccess(res, predictionMetricsService.getStrongBuySummary(range));

    }
    catch(err){ next(err); }

}

async function getFailureAnalysis(req, res, next){

    try{

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        sendSuccess(res, predictionMetricsService.getStatistics(range));

    }
    catch(err){ next(err); }

}

async function getWalletPerformance(req, res, next){

    try{

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        // 5000 mirrors ceoDashboardService's own WALLET_PERFORMANCE_MAX_LIMIT
        // hard cap (Part 12) - the service re-clamps regardless, this just
        // avoids handing it an obviously-bogus huge number up front.
        const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 20));

        const offset = Math.max(0, Number(req.query.offset) || 0);

        sendSuccess(res, ceoDashboardService.getWalletPerformance({

            category: req.query.category || undefined,

            from: range.from,

            to: range.to,

            q: req.query.q || undefined,

            limit,

            offset,

            sortBy: req.query.sortBy || undefined,

            direction: req.query.direction || undefined

        }));

    }
    catch(err){ next(err); }

}

async function getWalletCategories(req, res, next){

    try{ sendSuccess(res, { categories: ceoDashboardService.getAvailableWalletCategories() }); }
    catch(err){ next(err); }

}

async function getRecommendations(req, res, next){

    try{

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        sendSuccess(res, ceoDashboardService.getRecommendations(range));

    }
    catch(err){ next(err); }

}

async function getEngineHistory(req, res, next){

    try{ sendSuccess(res, { history: ceoDashboardService.getEngineHistory() }); }
    catch(err){ next(err); }

}

// Admin V3 - structured advisor (reason/currentValue/recommendedValue/
// expectedImprovement/confidence per advisory). Additive - does not
// replace getRecommendations/GET /admin/ceo/recommendations, which
// stays exactly as it was for backward compatibility.

async function getEngineAdvisor(req, res, next){

    try{

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        sendSuccess(res, ceoDashboardService.getEngineAdvisor(range));

    }
    catch(err){ next(err); }

}

// Section 10 - GET /admin/ceo/export?section=X&format=csv|xlsx&...
// Every table on the CEO Dashboard maps to one `section` key here -
// see ceoDashboardService.getExportableSections() for the real list.

async function exportTable(req, res, next){

    try{

        const range = parseDateRange(req.query);

        if(!range.valid) return sendError(res, 400, "Invalid query parameters", range.error);

        const section = req.query.section;

        const format = (req.query.format || "csv").toLowerCase();

        if(format !== "csv" && format !== "xlsx") return sendError(res, 400, "Invalid query parameters", "format must be csv or xlsx");

        const table = ceoDashboardService.getExportTable(section, {

            category: req.query.category || undefined,

            from: range.from,

            to: range.to,

            limit: Math.min(500, Math.max(1, Number(req.query.limit) || 100))

        });

        if(!table) return sendError(res, 400, "Invalid query parameters", `section must be one of: ${ceoDashboardService.getExportableSections().join(", ")}`);

        const filename = `${section}${range.from ? `_${range.from}_to_${range.to || range.from}` : "_all-time"}.${format}`;

        if(format === "csv"){

            res.setHeader("Content-Type", "text/csv; charset=utf-8");

            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

            return res.send(exportBuilder.toCsv(table.columns, table.rows));

        }

        const buffer = await exportBuilder.toXlsxBuffer(section, table.columns, table.rows);

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

        res.send(Buffer.from(buffer));

    }
    catch(err){ next(err); }

}

module.exports = {

    getEngineStatus,
    getSignalSummary,
    getResultSummary,
    getStrongBuyAnalysis,
    getFailureAnalysis,
    getWalletPerformance,
    getWalletCategories,
    getRecommendations,
    getEngineAdvisor,
    getEngineHistory,
    exportTable

};
