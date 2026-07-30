// middleware/userAuth.js - Sprint A, Goal 2 (auth/multi-tenancy
// foundation). Structurally modeled on middleware/adminAuth.js, but a
// fully separate system: reads a distinct X-Auth-Token header
// (deliberately different from admin's X-Admin-Key, so the two auth
// systems can never be confused with each other or accidentally
// interchanged), and - unlike adminAuth's boolean pass/fail - attaches
// the specific tenant's identity to req.user, since every downstream
// trading-bot repository/service call needs to know WHICH user's bot
// it's operating on.

const userAuthService = require("../services/userAuthService");
const { sendError } = require("../utils/apiResponse");

function userAuth(req, res, next){

    const token = req.headers["x-auth-token"];
    const userId = userAuthService.validateSession(token);

    if(!userId){
        return sendError(res, 401, "Unauthorized", "Missing, expired, or incorrect auth token");
    }

    req.user = { id: userId };
    next();

}

module.exports = userAuth;
