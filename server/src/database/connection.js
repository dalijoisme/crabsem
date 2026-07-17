// database/connection.js - the only file (besides migrate.js) that
// imports the SQLite driver directly. Everything else in the app
// talks to repositories, not to this file, so swapping SQLite for
// another database later only means rewriting what's in this folder.

const path = require("path");
const Database = require("better-sqlite3");
const config = require("../config/env");

const dbPath = path.resolve(__dirname, "../../", config.DB_PATH);

const db = new Database(dbPath);

db.pragma("foreign_keys = ON");

// WAL mode: lets API reads proceed without waiting on (or being
// blocked by) the scheduler's writes, and vice versa - the standard
// fix for exactly this "one writer, many readers, same SQLite file"
// shape. Without it, the default rollback-journal mode takes an
// exclusive lock per write, which is a real contention risk once the
// scheduler and the API are both hitting this file continuously.

db.pragma("journal_mode = WAL");

module.exports = db;
