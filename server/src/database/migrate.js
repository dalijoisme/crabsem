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

        // A migration that rebuilds a table another table has a real
        // FOREIGN KEY REFERENCES on (e.g. dropping/recreating
        // prediction_history while prediction_timeline references it)
        // cannot run inside the normal single-transaction wrapper below -
        // SQLite's own docs mandate PRAGMA foreign_keys=OFF be toggled
        // OUTSIDE any transaction for exactly this case (the pragma is a
        // documented no-op if changed while a transaction is already
        // open). Migrations opt into this path with a leading marker
        // comment; every other migration keeps the original, safer
        // single-transaction behavior unchanged.

        if(sql.trimStart().startsWith("-- REQUIRES_FK_OFF")){

            db.pragma("foreign_keys = OFF");

            try{

                const applyMigration = db.transaction(() => {

                    db.exec(sql);

                    db.prepare(
                        "INSERT INTO schema_migrations (filename) VALUES (?)"
                    ).run(file);

                });

                applyMigration();

            }
            finally{

                db.pragma("foreign_keys = ON");

                // Real integrity check, not just re-enabling the flag -
                // if the rebuild left any dangling reference, fail loudly
                // now rather than silently later.
                const violations = db.pragma("foreign_key_check");

                if(violations.length){

                    throw new Error(`Migration ${file} left ${violations.length} foreign key violation(s): ${JSON.stringify(violations)}`);

                }

            }

            console.log(`Migration applied (FK-off mode): ${file}`);

            return;

        }

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
