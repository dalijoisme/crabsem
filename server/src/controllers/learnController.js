// controllers/learnController.js - thin HTTP layer for the Learn
// System (Product Improvement Sprint, Part 7). Gated by adminAuth at
// the router level - see routes/v1/admin.js.

const learnService = require("../services/learnService");
const { sendSuccess } = require("../utils/apiResponse");

async function getSummary(req, res, next){

    try{ sendSuccess(res, learnService.getLearnSummary()); }
    catch(err){ next(err); }

}

module.exports = { getSummary };
