require("dotenv").config();

const config = Object.freeze({

    PORT: Number(process.env.PORT) || 4000,

    DB_PATH: process.env.DB_PATH || "./data/crabsem.sqlite",

    NODE_ENV: process.env.NODE_ENV || "development",

    // Comma-separated list of allowed browser origins for CORS, e.g.
    // "https://crabsem.com,https://www.crabsem.com". Empty in
    // development (falls back to permissive CORS - see app.js) so
    // local dev keeps working with no setup; required to be set for
    // a production deployment (see the production-readiness audit).
    CORS_ALLOWED_ORIGINS: (process.env.CORS_ALLOWED_ORIGINS || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean),

    // GMGN OpenAPI - GMGN_PRIVATE_KEY is stored with escaped \n (see
    // collectors/gmgn/generateKeys.js), restored to real newlines here.

    GMGN_API_KEY: process.env.GMGN_API_KEY || null,

    GMGN_PRIVATE_KEY: process.env.GMGN_PRIVATE_KEY
        ? process.env.GMGN_PRIVATE_KEY.replace(/\\n/g, "\n")
        : null,

    GMGN_HOST: process.env.GMGN_HOST || "https://openapi.gmgn.ai",

    // Admin Panel (engine-quality sprint) - a single shared password,
    // no role system yet (explicitly out of scope for this sprint).
    // null (unset) means the admin API is fully disabled rather than
    // silently open - see middleware/adminAuth.js.
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || null

});

module.exports = config;
