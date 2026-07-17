const validationMetricsService = require("../services/validationMetricsService");
const { sendSuccess } = require("../utils/apiResponse");

async function getSummary(req, res, next){

    try{

        sendSuccess(res, validationMetricsService.getValidationSummary());

    }
    catch(err){

        next(err);

    }

}

module.exports = { getSummary };
