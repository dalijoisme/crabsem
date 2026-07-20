const express = require("express");
const cors = require("cors");
const config = require("./config/env");
const routes = require("./routes");
const errorHandler = require("./middleware/errorHandler");

const app = express();

// Disable Express's default weak ETag generation and force
// no-store on every /api response (Recommendation Lifecycle redesign,
// investigating a real report of a rugged token still showing at #1
// on trending). Root cause: this is a real-time API - every value
// (recommendation, confidence, decay) is meant to change from one
// request to the next - but Express enables weak ETags by default,
// and without an explicit Cache-Control, browsers are free to serve a
// GET response straight from their own heuristic cache instead of
// hitting the network again. A user's browser could keep showing an
// old, since-excluded /trending or /token/:address response long
// after the server-side fix went live and would have zero way to
// know it was stale. This was never a live-recommendation-logic bug -
// it was the transport allowing an old, correct-at-the-time response
// to be replayed indefinitely.

app.set("etag", false);

app.use((req, res, next) => {

    res.set("Cache-Control", "no-store");

    next();

});

// Wide-open CORS (no allowlist) is fine for local development, but
// was found unconditional in every environment - see the
// production-readiness audit. When CORS_ALLOWED_ORIGINS is set (a
// real deployment should set it), only those origins are allowed;
// left empty, this falls back to the original permissive behavior so
// local dev needs no extra setup.

const corsOptions = config.CORS_ALLOWED_ORIGINS.length
    ? {
        origin(origin, callback){

            // requests with no Origin header (curl, server-to-server,
            // same-origin) are always allowed - CORS only governs
            // browser cross-origin requests in the first place.
            if(!origin || config.CORS_ALLOWED_ORIGINS.includes(origin)) return callback(null, true);

            callback(new Error(`Origin not allowed: ${origin}`));

        }
      }
    : undefined;

if(config.NODE_ENV === "production" && !config.CORS_ALLOWED_ORIGINS.length){

    console.warn("[startup] WARNING: NODE_ENV=production but CORS_ALLOWED_ORIGINS is empty - CORS is wide open to every origin.");

}

app.use(cors(corsOptions));
app.use(express.json());

// Minimal request log - previously nothing recorded method/path/
// status/latency per request at all (see the production-readiness
// audit: no access log to correlate with an error report, no visible
// request volume). Deliberately not a full logging library - one
// line per request, structured enough to grep/parse.

app.use((req, res, next) => {

    const startedAt = Date.now();

    res.on("finish", () => {

        const durationMs = Date.now() - startedAt;

        console.log(`[http] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);

    });

    next();

});

app.use("/api", routes);

// Any /api/* path that didn't match a route above - keeps 404s as
// the same consistent JSON envelope as every other error, instead
// of Express's default HTML 404 page.

app.use("/api", (req, res) => {

    res.status(404).json({

        success: false,

        error: "Not Found",

        details: `No route matches ${req.method} ${req.originalUrl}`

    });

});

app.use(errorHandler);

module.exports = app;
