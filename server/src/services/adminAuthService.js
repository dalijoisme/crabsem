// services/adminAuthService.js - Admin Panel login (POST /admin/login
// issues a session token; middleware/adminAuth.js verifies it on every
// subsequent /admin/* request). No role system, no database table -
// tokens live in an in-memory Map for the life of the Node process,
// which is the correct minimal scope for a single-shared-password
// admin panel with no per-user accounts.
//
// The actual password is never generated or stored here - it is
// read once from process.env.ADMIN_PASSWORD (see config/env.js) and
// compared directly; login only ever succeeds if that env var is set
// AND the submitted password matches it exactly.

const crypto = require("crypto");
const config = require("../config/env");

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const sessions = new Map(); // token -> expiresAt (ms epoch)

function login(password){

    if(!config.ADMIN_PASSWORD){

        return { ok: false, status: 503, error: "Admin panel not configured", details: "ADMIN_PASSWORD is not set in server/.env" };

    }

    if(!password || password !== config.ADMIN_PASSWORD){

        return { ok: false, status: 401, error: "Unauthorized", details: "Incorrect password" };

    }

    const token = crypto.randomBytes(32).toString("hex");

    sessions.set(token, Date.now() + SESSION_TTL_MS);

    return { ok: true, token };

}

function isValidToken(token){

    if(!token) return false;

    const expiresAt = sessions.get(token);

    if(!expiresAt) return false;

    if(Date.now() > expiresAt){

        sessions.delete(token);

        return false;

    }

    return true;

}

module.exports = { login, isValidToken };
