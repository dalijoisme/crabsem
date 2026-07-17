const tokenQueryService = require("../services/tokenQueryService");
const { validateListQuery, validateLimit } = require("../utils/validators");
const { sendSuccess, sendError } = require("../utils/apiResponse");

async function listTokens(req, res, next){

    try{

        const validation = validateListQuery(req.query);

        if(!validation.valid){

            return sendError(res, 400, "Invalid query parameters", validation.errors.join("; "));

        }

        const result = tokenQueryService.listTokens(validation);

        sendSuccess(res, result);

    }
    catch(err){

        next(err);

    }

}

async function getTokenByAddress(req, res, next){

    try{

        const address = (req.params.address || "").trim();

        if(address.length < 10 || address.length > 100){

            return sendError(
                res, 400, "Invalid token address",
                "address must be a non-empty string between 10 and 100 characters"
            );

        }

        const token = tokenQueryService.getTokenByAddress(address);

        if(!token){

            return sendError(res, 404, "Token not found", `No token found for address: ${address}`);

        }

        sendSuccess(res, token);

    }
    catch(err){

        next(err);

    }

}

async function getTrending(req, res, next){

    try{

        const limitCheck = validateLimit(req.query.limit, 20);

        if(!limitCheck.valid){

            return sendError(res, 400, "Invalid query parameters", limitCheck.error);

        }

        const result = tokenQueryService.getTrending(limitCheck.limit);

        sendSuccess(res, result);

    }
    catch(err){

        next(err);

    }

}

module.exports = { listTokens, getTokenByAddress, getTrending };
