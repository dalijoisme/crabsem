// repositories/gmgnLaunchpadStatsRepository.js - the only place that
// reads/writes gmgn_launchpad_stats (upserted snapshot, one row per
// launchpad platform).

const db = require("../database/connection");

const upsertStmt = db.prepare(`
    INSERT INTO gmgn_launchpad_stats (launchpad, token_count, updated_at)
    VALUES (@launchpad, @tokenCount, CURRENT_TIMESTAMP)
    ON CONFLICT(launchpad) DO UPDATE SET
        token_count = excluded.token_count,
        updated_at = CURRENT_TIMESTAMP
`);

function upsertEntries(entries){

    const runMany = db.transaction((items) => {

        items.forEach(e => upsertStmt.run(e));

    });

    runMany(entries);

    return entries.length;

}

function findAll(){

    return db.prepare("SELECT launchpad, token_count, updated_at FROM gmgn_launchpad_stats ORDER BY token_count DESC").all();

}

function findByLaunchpad(launchpad){

    if(!launchpad) return null;

    return db.prepare("SELECT launchpad, token_count, updated_at FROM gmgn_launchpad_stats WHERE launchpad = ?").get(launchpad);

}

module.exports = { upsertEntries, findAll, findByLaunchpad };
