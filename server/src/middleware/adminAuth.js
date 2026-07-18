// middleware/adminAuth.js - gates every /api/v1/admin/* route behind
// a single shared password (see config/env.js's ADMIN_PASSWORD - no
// role system, explicitly out of scope for this sprint). Sent by the
// browser as the X-Admin-Key header, never as a query string (would
// leak into access logs/browser history).
//
// Fails CLOSED: if ADMIN_PASSWORD isn't configured at all, the admin
// API is fully disabled (503) rather than silently accepting any
// request - an unset password must never mean "open to everyone".

const config = require("../config/env");
const { sendError } = require("../utils/apiResponse");

function adminAuth(req, res, next){

    if(!config.ADMIN_PASSWORD){

        return sendError(res, 503, "Admin panel not configured", "ADMIN_PASSWORD is not set in server/.env - the admin API is disabled until it is.");

    }

    const provided = req.headers["x-admin-key"];

    if(!provided || provided !== config.ADMIN_PASSWORD){

        return sendError(res, 401, "Unauthorized", "Missing or incorrect admin key");

    }

    next();

}

module.exports = adminAuth;
