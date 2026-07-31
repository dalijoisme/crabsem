// database/connection.js - the only file (besides migrate.js) that
// imports the SQLite driver directly. Everything else in the app
// talks to repositories, not to this file, so swapping SQLite for
// another database later only means rewriting what's in this folder.

const path = require("path");
const Database = require("better-sqlite3");
const config = require("../config/env");

const dbPath = path.resolve(__dirname, "../../", config.DB_PATH);

const db = new Database(dbPath);

// TEMPORARY DIAGNOSTIC LOGGING - remove once it's confirmed which
// physical SQLite file the running process actually has open.
console.log("[database/connection] DIAG process.cwd() =", process.cwd());
console.log("[database/connection] DIAG config.DB_PATH (raw) =", config.DB_PATH);
console.log("[database/connection] DIAG path.resolve(config.DB_PATH) =", path.resolve(config.DB_PATH));
console.log("[database/connection] DIAG actual resolved dbPath (path.resolve(__dirname, '../../', config.DB_PATH)) =", dbPath);
console.log("[database/connection] DIAG PRAGMA database_list =", db.pragma("database_list"));

db.pragma("foreign_keys = ON");

// WAL mode: lets API reads proceed without waiting on (or being
// blocked by) the scheduler's writes, and vice versa - the standard
// fix for exactly this "one writer, many readers, same SQLite file"
// shape. Without it, the default rollback-journal mode takes an
// exclusive lock per write, which is a real contention risk once the
// scheduler and the API are both hitting this file continuously.

db.pragma("journal_mode = WAL");

// How long a write waits for a lock before throwing SQLITE_BUSY,
// instead of failing immediately. Same-process API + scheduler writes
// are already serialized safely by WAL above; this is a safety net
// for the standalone scripts in package.json (`scheduler:gmgn`,
// `collect:gmgn-trending`) which open a second process against the
// same file with no coordination otherwise - see the
// production-readiness audit.

db.pragma("busy_timeout = 5000");

module.exports = db;
