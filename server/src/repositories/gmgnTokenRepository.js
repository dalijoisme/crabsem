// repositories/gmgnTokenRepository.js - the only place that writes
// or reads gmgn_tokens. Callers (collectors) pass plain JS token
// objects in; this file owns the SQL and the SQLite-specific
// upsert/timestamp conventions, so swapping the database engine
// later means changing this file, not the collector that calls it.

const db = require("../database/connection");
const { SORTABLE_COLUMNS } = require("../utils/validators");

// Columns returned by list-style queries (findMany). raw_json is
// deliberately excluded here - it's a large blob only the
// single-token detail endpoint needs, so list/trending/search
// queries never pay for it (see the "no SELECT *" performance rule).
const LIST_COLUMNS = `
    id, token_address, symbol, name, chain, logo,
    market_cap, liquidity, price,
    price_change_5m, price_change_1h, price_change_24h,
    volume_5m, volume_1h, volume_24h,
    buys_5m, sells_5m, holders, fdv,
    launch_time, last_seen, updated_at
`;

const upsertStmt = db.prepare(`
    INSERT INTO gmgn_tokens (
        token_address, symbol, name, chain, logo,
        market_cap, liquidity, price,
        price_change_5m, price_change_1h, price_change_24h,
        volume_5m, volume_1h, volume_24h,
        buys_5m, sells_5m,
        holders, fdv,
        launch_time, last_seen, updated_at, raw_json
    ) VALUES (
        @tokenAddress, @symbol, @name, @chain, @logo,
        @marketCap, @liquidity, @price,
        @priceChange5m, @priceChange1h, @priceChange24h,
        @volume5m, @volume1h, @volume24h,
        @buys5m, @sells5m,
        @holders, @fdv,
        datetime(@launchTimestamp, 'unixepoch'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, @rawJson
    )
    ON CONFLICT(token_address) DO UPDATE SET
        symbol = excluded.symbol,
        name = excluded.name,
        chain = excluded.chain,
        logo = excluded.logo,
        market_cap = excluded.market_cap,
        liquidity = excluded.liquidity,
        price = excluded.price,
        price_change_5m = excluded.price_change_5m,
        price_change_1h = excluded.price_change_1h,
        price_change_24h = excluded.price_change_24h,
        volume_5m = excluded.volume_5m,
        volume_1h = excluded.volume_1h,
        volume_24h = excluded.volume_24h,
        buys_5m = excluded.buys_5m,
        sells_5m = excluded.sells_5m,
        holders = excluded.holders,
        fdv = excluded.fdv,
        launch_time = excluded.launch_time,
        last_seen = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP,
        raw_json = excluded.raw_json
`);

function upsertToken(token){

    upsertStmt.run(token);

}

// Upserts every token inside a single transaction - either all rows
// apply or none do, and it is far faster than one transaction per row.

function upsertTokens(tokens){

    const runMany = db.transaction((items) => {

        items.forEach(t => upsertStmt.run(t));

    });

    runMany(tokens);

    return tokens.length;

}

function countTokens(){

    return db.prepare("SELECT COUNT(*) as count FROM gmgn_tokens").get().count;

}

function getTokenByAddress(tokenAddress){

    return db.prepare("SELECT * FROM gmgn_tokens WHERE token_address = ?").get(tokenAddress);

}

function getAllTokens(){

    return db.prepare("SELECT * FROM gmgn_tokens ORDER BY market_cap DESC").all();

}

// Fresh BUY Universe RFC (services/freshUniverseService.js): the
// collector (trendingCollector.js) only refreshes rows still in GMGN's
// trending list, so getAllTokens() carries stale rows forward
// indefinitely. This is the SQL-side freshness + market-cap filter -
// same "market_cap > 0" floor getAllTokens() callers used to apply in
// JS after the fact (scheduler/tradingBotScheduler.js), now pushed into
// the query so it can use idx_gmgn_tokens_updated_at_market_cap
// (migration 063) instead of full-scanning. SELECT * (not the
// LIST_COLUMNS trimmed set) to keep exact column parity with
// getAllTokens() - only row COUNT changes for downstream scoring, never
// which fields a token object carries.
//
// EXPLAIN QUERY PLAN, verified against this account's own real ~12.5k-row
// dev DB (per the RFC's own required verification step, not assumed):
// with market_cap > 0 true for essentially every row and no ANALYZE
// stats collected, SQLite's planner picks the pre-existing
// idx_gmgn_tokens_market_cap instead - it satisfies ORDER BY market_cap
// DESC for free, which its heuristic (no real row-count stats available)
// values over the freshness predicate. That plan is wrong for THIS
// query: it still has to touch every market_cap>0 row (i.e. nearly the
// whole table) to check updated_at, which is exactly the full-scan this
// index was added to avoid. `INDEXED BY` forces the freshness index,
// which is genuinely faster here because only a small fraction of rows
// are ever fresh - the resulting (small) row set is then sorted in a
// temp b-tree, verified cheap at this scale.
function getFreshTokens({ maxAgeSeconds, minMarketCap }){

    return db.prepare(`
        SELECT * FROM gmgn_tokens INDEXED BY idx_gmgn_tokens_updated_at_market_cap
        WHERE updated_at >= datetime('now', '-' || @maxAgeSeconds || ' seconds')
          AND market_cap > @minMarketCap
        ORDER BY market_cap DESC
    `).all({ maxAgeSeconds, minMarketCap });

}

function buildSearchClause(search){

    if(!search) return { whereClause: "", params: {} };

    return {

        whereClause: "WHERE (symbol LIKE @search OR name LIKE @search OR token_address LIKE @search)",

        params: { search: `%${search}%` }

    };

}

// Paginated / sorted / filtered list - backs GET /tokens, /trending,
// and /search, which all differ only in their default sort/search.
//
// `sortColumn`/`direction` are interpolated directly into SQL
// (SQLite has no way to parameterize an ORDER BY column or
// direction). This is only safe because callers MUST validate them
// against SORTABLE_COLUMNS first (see utils/validators.js) - this
// function re-checks that allow-list itself as a defense-in-depth
// guard against being called with unvalidated input by mistake.

function findMany({ limit, offset = 0, sortColumn, direction = "DESC", search = null }){

    if(!SORTABLE_COLUMNS.includes(sortColumn)){

        throw new Error(`findMany: "${sortColumn}" is not an allowed sort column`);

    }

    const dir = direction === "ASC" ? "ASC" : "DESC";

    const { whereClause, params } = buildSearchClause(search);

    const sql = `
        SELECT ${LIST_COLUMNS}
        FROM gmgn_tokens
        ${whereClause}
        ORDER BY ${sortColumn} ${dir}
        LIMIT @limit OFFSET @offset
    `;

    return db.prepare(sql).all({ ...params, limit, offset });

}

function countMany({ search = null } = {}){

    const { whereClause, params } = buildSearchClause(search);

    const row = db.prepare(`SELECT COUNT(*) as count FROM gmgn_tokens ${whereClause}`).get(params);

    return row.count;

}

function getStats(){

    return db.prepare(`
        SELECT
            COUNT(*) as tokenCount,
            MAX(updated_at) as lastUpdate,
            AVG(market_cap) as avgMarketCap,
            MAX(market_cap) as maxMarketCap,
            AVG(liquidity) as avgLiquidity,
            AVG(holders) as avgHolders
        FROM gmgn_tokens
    `).get();

}

module.exports = {
    upsertToken,
    upsertTokens,
    countTokens,
    getTokenByAddress,
    getAllTokens,
    getFreshTokens,
    findMany,
    countMany,
    getStats
};
