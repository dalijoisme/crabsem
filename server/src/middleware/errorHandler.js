const config = require("../config/env");

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next){

    console.error(`[error] ${req.method} ${req.originalUrl} ->`, err);

    const status = err.status || 500;

    // Previously always returned the raw err.message regardless of
    // NODE_ENV - in production that can leak internal detail (SQL
    // error text, file paths) to any client. See the
    // production-readiness audit; unchanged behavior in development.

    const details = config.NODE_ENV === "production"
        ? (status < 500 ? (err.message || "") : "")
        : (err.message || "");

    res.status(status).json({

        success: false,

        error: status < 500 ? (err.publicMessage || "Request failed") : "Internal Server Error",

        details

    });

}

module.exports = errorHandler;
