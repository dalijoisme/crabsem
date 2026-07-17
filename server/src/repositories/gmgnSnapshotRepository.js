// repositories/gmgnSnapshotRepository.js - the only place that writes
// GMGN collector output to the database. Callers (collectors) pass
// plain JS values in; this file is the one that knows the SQL/SQLite
// specifics, so swapping the database engine later means changing
// this file, not the collector that calls it.

const db = require("../database/connection");

function insertSnapshot({ endpoint, requestParams, rawResponse }){

    const stmt = db.prepare(`
        INSERT INTO gmgn_raw_snapshots (endpoint, request_params, raw_response)
        VALUES (?, ?, ?)
    `);

    const info = stmt.run(endpoint, JSON.stringify(requestParams), rawResponse);

    return info.lastInsertRowid;

}

function countSnapshots(endpoint){

    const row = db.prepare(
        "SELECT COUNT(*) as count FROM gmgn_raw_snapshots WHERE endpoint = ?"
    ).get(endpoint);

    return row.count;

}

function getLatestSnapshot(endpoint){

    return db.prepare(`
        SELECT id, endpoint, request_params, raw_response, fetched_at
        FROM gmgn_raw_snapshots
        WHERE endpoint = ?
        ORDER BY id DESC
        LIMIT 1
    `).get(endpoint);

}

// Lean version of getLatestSnapshot() for callers (health check) that
// only need to know *when* the last run happened, not the payload -
// avoids pulling the (potentially large) raw_response column.

function getLatestSnapshotMeta(endpoint){

    return db.prepare(`
        SELECT id, endpoint, fetched_at
        FROM gmgn_raw_snapshots
        WHERE endpoint = ?
        ORDER BY id DESC
        LIMIT 1
    `).get(endpoint);

}

// Retention: raw_response blobs are only ever read for the most
// recent row (getLatestSnapshot/Meta) - older ones exist purely for
// point-in-time debugging, not for any live feature, so they're safe
// to prune once older than `maxAgeHours`. token_price_history is the
// structured, indexed alternative for anything that needs real
// historical price data.

function pruneOlderThan(maxAgeHours){

    const info = db.prepare(`
        DELETE FROM gmgn_raw_snapshots
        WHERE datetime(fetched_at) < datetime('now', '-' || ? || ' hours')
    `).run(maxAgeHours);

    return info.changes;

}

module.exports = { insertSnapshot, countSnapshots, getLatestSnapshot, getLatestSnapshotMeta, pruneOlderThan };
