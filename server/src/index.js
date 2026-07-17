// index.js - the single production entry point. Brings up the whole
// pipeline in one process (DB -> migrations -> scheduler -> API), so
// `npm start` alone is enough for the backend to be immediately
// usable - no separate terminal/process required to keep data
// flowing. Running the scheduler in the same process also means the
// API and the collectors share one SQLite connection, removing any
// cross-process lock contention risk (WAL mode, set in
// database/connection.js, handles the remaining same-process
// read/write overlap safely).

const config = require("./config/env");
const { runMigrations } = require("./database/migrate");
const gmgnScheduler = require("./scheduler/gmgnTrendingScheduler");
const app = require("./app");

// Production safety net: one uncaught error anywhere (a bug in a
// future collector, a bad promise chain, etc.) must never be allowed
// to silently kill the whole process - that would take down the API
// along with whatever actually failed. Logged loudly so the root
// cause is visible, but the process stays up; the scheduler's own
// per-collector try/catch (see gmgnTrendingScheduler.js) already
// isolates individual collector failures from each other, and this
// is the last-resort backstop for everything else.

process.on("unhandledRejection", (reason) => {

    console.error("[FATAL-GUARD] Unhandled promise rejection (process kept alive):", reason);

});

process.on("uncaughtException", (err) => {

    console.error("[FATAL-GUARD] Uncaught exception (process kept alive):", err);

});

console.log("[startup] Connecting to database...");

runMigrations();

console.log(`[startup] Database connected and migrated: ${config.DB_PATH}`);

console.log("[startup] Starting GMGN collectors on the scheduler...");

const schedulerHandle = gmgnScheduler.start();

console.log(`[startup] Scheduler running - ${gmgnScheduler.COLLECTORS.length} collectors every ${gmgnScheduler.INTERVAL_MS / 1000}s`);

const server = app.listen(config.PORT, () => {

    console.log(`[startup] API ready - CRAB AGENT server listening on port ${config.PORT}`);

    console.log(`[startup] Dashboard: open dashboard.html in a browser (via wallet.html) - it reads live data from this API, never from GMGN directly.`);

});

function shutdown(signal){

    console.log(`[shutdown] ${signal} received - stopping scheduler and server...`);

    schedulerHandle.stop();

    server.close(() => {

        console.log("[shutdown] Server closed. Exiting.");

        process.exit(0);

    });

}

process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGTERM", () => shutdown("SIGTERM"));
