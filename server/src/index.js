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
const db = require("./database/connection");
const { runMigrations } = require("./database/migrate");
const gmgnScheduler = require("./scheduler/gmgnTrendingScheduler");
const validationScheduler = require("./scheduler/validationScheduler");
const walletScheduler = require("./scheduler/walletScheduler");
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

// Startup secret validation: previously a missing GMGN_API_KEY/
// GMGN_PRIVATE_KEY was only discovered lazily, at the first
// on-demand request (503) or first scheduler tick (silently logged
// and skipped) - the server would report itself fully healthy in the
// meantime. Loud and immediate instead, without refusing to start:
// the API itself (reading already-collected data) works fine with no
// GMGN credentials at all, only the collectors need them.

if(!config.GMGN_API_KEY || !config.GMGN_PRIVATE_KEY){

    console.warn(
        "[startup] WARNING: GMGN_API_KEY/GMGN_PRIVATE_KEY not fully configured in server/.env - " +
        "the GMGN collectors will fail every tick until this is fixed. Run `npm run gmgn:generate-keys`, " +
        "register the printed public key at https://gmgn.ai/ai, then set GMGN_API_KEY in server/.env. " +
        "The API itself will still serve whatever data was already collected."
    );

}

console.log("[startup] Starting GMGN collectors on the scheduler...");

const schedulerHandle = gmgnScheduler.start();

console.log(`[startup] Scheduler running - ${gmgnScheduler.COLLECTORS.length} collectors every ${gmgnScheduler.INTERVAL_MS / 1000}s`);

const validationSchedulerHandle = validationScheduler.start();

const walletSchedulerHandle = walletScheduler.start();

const server = app.listen(config.PORT, () => {

    console.log(`[startup] API ready - CRAB AGENT server listening on port ${config.PORT}`);

    console.log(`[startup] Dashboard: open dashboard.html in a browser (via wallet.html) - it reads live data from this API, never from GMGN directly.`);

});

let shuttingDown = false;

function shutdown(signal){

    if(shuttingDown) return;

    shuttingDown = true;

    console.log(`[shutdown] ${signal} received - stopping scheduler and server...`);

    schedulerHandle.stop();

    validationSchedulerHandle.stop();

    walletSchedulerHandle.stop();

    // Previously never closed the shared better-sqlite3 connection,
    // relying on process exit to release the file handle - in WAL
    // mode that can leave the -wal/-shm sidecar files without an
    // explicit checkpoint. See the production-readiness audit.

    const finish = () => {

        try{ db.close(); }
        catch(err){ console.error("[shutdown] Error closing database:", err.message); }

        console.log("[shutdown] Server and database closed. Exiting.");

        process.exit(0);

    };

    // Previously had no forced-exit fallback - if server.close()'s
    // callback never fired (e.g. a client holding a keep-alive socket
    // open), SIGTERM would hang indefinitely.

    const forceTimer = setTimeout(() => {

        console.warn("[shutdown] server.close() did not finish in time - forcing exit.");

        finish();

    }, 5000);

    server.close(() => {

        clearTimeout(forceTimer);

        finish();

    });

}

process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGTERM", () => shutdown("SIGTERM"));
