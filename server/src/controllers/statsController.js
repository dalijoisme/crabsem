const statsService = require("../services/statsService");
const { sendSuccess } = require("../utils/apiResponse");

async function getStats(req, res, next){

    try{

        const stats = statsService.getStats();

        sendSuccess(res, stats);

    }
    catch(err){

        next(err);

    }

}

module.exports = { getStats };
