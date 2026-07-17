const tokenQueryService = require("../services/tokenQueryService");
const { validateLimit } = require("../utils/validators");
const { sendSuccess, sendError } = require("../utils/apiResponse");

async function search(req, res, next){

    try{

        const q = (req.query.q || "").toString().trim();

        if(q === ""){

            return sendError(res, 400, "Invalid query parameters", "q is required");

        }

        const limitCheck = validateLimit(req.query.limit, 50);

        if(!limitCheck.valid){

            return sendError(res, 400, "Invalid query parameters", limitCheck.error);

        }

        const result = tokenQueryService.search(q, limitCheck.limit);

        sendSuccess(res, result);

    }
    catch(err){

        next(err);

    }

}

module.exports = { search };
