const { checkHealth } = require("../services/health");
const { sendSuccess } = require("../utils/apiResponse");

async function getHealth(req, res, next){

    try{

        const result = checkHealth();

        // A degraded scheduler is still a 200 at the transport level
        // in the old code, which made this endpoint useless for any
        // orchestrator/uptime monitor that gates on HTTP status
        // rather than parsing the body - see the production-readiness
        // audit. 503 here means "collector data has stopped flowing",
        // not "the API process is down" (which would fail to respond
        // at all).

        const httpStatus = result.status === "ok" ? 200 : 503;

        res.status(httpStatus);

        sendSuccess(res, result);

    }
    catch(err){

        next(err);

    }

}

module.exports = { getHealth };
