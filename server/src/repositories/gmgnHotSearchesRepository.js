// repositories/gmgnHotSearchesRepository.js - the only place that
// reads/writes gmgn_hot_searches.

const db = require("../database/connection");

const upsertStmt = db.prepare(`
    INSERT INTO gmgn_hot_searches (
        token_address, symbol, name, chain, interval, rank_position,
        price, market_cap, liquidity, volume, price_change_percent,
        holders, raw_json, updated_at
    ) VALUES (
        @tokenAddress, @symbol, @name, @chain, @interval, @rankPosition,
        @price, @marketCap, @liquidity, @volume, @priceChangePercent,
        @holders, @rawJson, CURRENT_TIMESTAMP
    )
    ON CONFLICT(chain, interval, token_address) DO UPDATE SET
        symbol = excluded.symbol,
        name = excluded.name,
        rank_position = excluded.rank_position,
        price = excluded.price,
        market_cap = excluded.market_cap,
        liquidity = excluded.liquidity,
        volume = excluded.volume,
        price_change_percent = excluded.price_change_percent,
        holders = excluded.holders,
        raw_json = excluded.raw_json,
        updated_at = CURRENT_TIMESTAMP
`);

function upsertEntries(entries){

    const runMany = db.transaction((items) => {

        items.forEach(e => upsertStmt.run(e));

    });

    runMany(entries);

    return entries.length;

}

function findByChain(chain, interval, limit = 50){

    return db.prepare(`
        SELECT id, token_address, symbol, name, chain, interval, rank_position,
               price, market_cap, liquidity, volume, price_change_percent, holders, updated_at
        FROM gmgn_hot_searches
        WHERE chain = ? AND interval = ?
        ORDER BY rank_position ASC
        LIMIT ?
    `).all(chain, interval, limit);

}

function countAll(){

    return db.prepare("SELECT COUNT(*) as count FROM gmgn_hot_searches").get().count;

}

function findByToken(tokenAddress){

    return db.prepare(`
        SELECT chain, interval, rank_position, price_change_percent, updated_at
        FROM gmgn_hot_searches
        WHERE token_address = ?
        ORDER BY updated_at DESC
        LIMIT 1
    `).get(tokenAddress);

}

// Batch version of findByToken for the Intelligence Engine's
// list-mode analysis - one query per page instead of one per token.
// Same "latest updated_at wins" tie-break as findByToken.

function findManyByTokenAddresses(tokenAddresses){

    const map = new Map();

    if(!tokenAddresses.length) return map;

    const CHUNK = 400;

    for(let i = 0; i < tokenAddresses.length; i += CHUNK){

        const chunk = tokenAddresses.slice(i, i + CHUNK);

        const placeholders = chunk.map(() => "?").join(",");

        const rows = db.prepare(`
            SELECT token_address, chain, interval, rank_position, price_change_percent, updated_at
            FROM gmgn_hot_searches
            WHERE token_address IN (${placeholders})
            ORDER BY updated_at DESC
        `).all(...chunk);

        for(const row of rows){

            if(!map.has(row.token_address)) map.set(row.token_address, row);

        }

    }

    return map;

}

module.exports = { upsertEntries, findByChain, countAll, findByToken, findManyByTokenAddresses };
