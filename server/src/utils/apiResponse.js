// utils/apiResponse.js - the two consistent JSON envelope shapes
// every v1 endpoint uses. Controllers call these instead of calling
// res.json() directly, so the shape can never drift between routes.

function sendSuccess(res, data){

    res.json({ success: true, data });

}

function sendError(res, status, error, details = ""){

    res.status(status).json({ success: false, error, details: details || "" });

}

module.exports = { sendSuccess, sendError };
