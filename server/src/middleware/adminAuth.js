// middleware/adminAuth.js - gates every /api/v1/admin/* route (except
// POST /admin/login itself - see routes/v1/admin.js) behind a real
// login-issued session token (see services/adminAuthService.js),
// sent by the browser as the X-Admin-Key header, never as a query
// string (would leak into access logs/browser history). The raw
// ADMIN_PASSWORD (see config/env.js) is also still accepted directly
// for server-to-server/manual curl use - a session token is simply
// what POST /admin/login hands back after checking that same
// password once, so the browser never has to keep resending it.
//
// Fails CLOSED: if ADMIN_PASSWORD isn't configured at all, the admin
// API is fully disabled (503) rather than silently accepting any
// request - an unset password must never mean "open to everyone".

const config = require("../config/env");
const adminAuthService = require("../services/adminAuthService");
const { sendError } = require("../utils/apiResponse");

function adminAuth(req, res, next){

    if(!config.ADMIN_PASSWORD){

        return sendError(res, 503, "Admin panel not configured", "ADMIN_PASSWORD is not set in server/.env - the admin API is disabled until it is.");

    }

    const provided = req.headers["x-admin-key"];

    if(!provided || (provided !== config.ADMIN_PASSWORD && !adminAuthService.isValidToken(provided))){

        return sendError(res, 401, "Unauthorized", "Missing, expired, or incorrect admin key/token");

    }

    next();

}

module.exports = adminAuth;
