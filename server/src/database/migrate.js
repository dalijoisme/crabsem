// database/migrate.js - applies numbered .sql files from
// database/migrations/ in order, tracking what's already been
// applied in the schema_migrations table. That table is created
// by 001_init.sql itself, not hardcoded here, so the migrations
// folder stays the single source of truth for schema history.

const fs = require("fs");
const path = require("path");
const db = require("./connection");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function migrationsTableExists(){

    const row = db.prepare(

        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"

    ).get();

    return Boolean(row);

}

function getAppliedMigrations(){

    if(!migrationsTableExists()) return new Set();

    const rows = db.prepare("SELECT filename FROM schema_migrations").all();

    return new Set(rows.map(r => r.filename));

}

function runMigrations(){

    const applied = getAppliedMigrations();

    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith(".sql"))
        .sort();

    files.forEach(file => {

        if(applied.has(file)) return;

        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");

        const applyMigration = db.transaction(() => {

            db.exec(sql);

            db.prepare(
                "INSERT INTO schema_migrations (filename) VALUES (?)"
            ).run(file);

        });

        applyMigration();

        console.log(`Migration applied: ${file}`);

    });

}

module.exports = { runMigrations };
