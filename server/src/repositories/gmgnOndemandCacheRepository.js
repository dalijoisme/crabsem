// repositories/gmgnOndemandCacheRepository.js - generic TTL cache
// shared by every on-demand (per-token / per-wallet) GMGN endpoint,
// instead of one bespoke table per endpoint. Stores the real GMGN
// response verbatim, keyed by endpoint + params - never fabricates
// or mutates the cached payload.

const db = require("../database/connection");

function get(cacheKey){

    const row = db.prepare(`
        SELECT response_json, fetched_at, expires_at
        FROM gmgn_ondemand_cache
        WHERE cache_key = ?
    `).get(cacheKey);

    if(!row) return null;

    const expired = new Date(`${row.expires_at.replace(" ", "T")}Z`).getTime() <= Date.now();

    if(expired) return null;

    return {

        data: JSON.parse(row.response_json),

        fetchedAt: row.fetched_at,

        cacheHit: true

    };

}

const upsertStmt = db.prepare(`
    INSERT INTO gmgn_ondemand_cache (cache_key, endpoint, params_json, response_json, fetched_at, expires_at)
    VALUES (@cacheKey, @endpoint, @paramsJson, @responseJson, CURRENT_TIMESTAMP, @expiresAt)
    ON CONFLICT(cache_key) DO UPDATE SET
        response_json = excluded.response_json,
        fetched_at = CURRENT_TIMESTAMP,
        expires_at = excluded.expires_at
`);

function set({ cacheKey, endpoint, params, response, ttlSeconds }){

    const expiresAt = new Date(Date.now() + ttlSeconds*1000).toISOString().slice(0,19).replace("T"," ");

    upsertStmt.run({

        cacheKey,

        endpoint,

        paramsJson: JSON.stringify(params),

        responseJson: JSON.stringify(response),

        expiresAt

    });

}

function countByEndpoint(endpoint){

    return db.prepare("SELECT COUNT(*) as count FROM gmgn_ondemand_cache WHERE endpoint = ?").get(endpoint).count;

}

// Used by the Intelligence Engine, which only ever SUMMARIZES data
// already collected - it must never trigger a new live GMGN call
// itself (that would make opening the detail panel slow and hammer
// the rate limit). Ignores expires_at deliberately: stale-but-real
// data is still real data, and is presented with its real fetchedAt
// timestamp so the caller can show its age honestly - it is never
// treated as fabricated or silently refreshed.

function getIgnoringExpiry(cacheKey){

    const row = db.prepare(`
        SELECT response_json, fetched_at
        FROM gmgn_ondemand_cache
        WHERE cache_key = ?
    `).get(cacheKey);

    if(!row) return null;

    return { data: JSON.parse(row.response_json), fetchedAt: row.fetched_at };

}

function buildCacheKey(endpoint, params){

    return `${endpoint}:${JSON.stringify(params)}`;

}

module.exports = { get, set, countByEndpoint, getIgnoringExpiry, buildCacheKey };
