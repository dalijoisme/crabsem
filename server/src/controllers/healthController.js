const { checkHealth } = require("../services/health");
const { sendSuccess } = require("../utils/apiResponse");

async function getHealth(req, res, next){

    try{

        const result = checkHealth();

        sendSuccess(res, result);

    }
    catch(err){

        next(err);

    }

}

module.exports = { getHealth };
