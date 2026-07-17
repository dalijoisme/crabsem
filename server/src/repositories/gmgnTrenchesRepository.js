// repositories/gmgnTrenchesRepository.js - the only place that
// reads/writes gmgn_trenches (new_creation / near_completion(pump) /
// completed token launches).

const db = require("../database/connection");

const upsertStmt = db.prepare(`
    INSERT INTO gmgn_trenches (
        section, token_address, symbol, name, chain,
        market_cap, liquidity, holders, progress, status,
        swaps_24h, buys_24h, sells_24h, net_buy_24h,
        rug_ratio, top_10_holder_rate, is_honeypot,
        renounced_mint, renounced_freeze_account,
        sniper_count, smart_degen_count,
        creator, launchpad, launchpad_platform, created_timestamp,
        raw_json, updated_at
    ) VALUES (
        @section, @tokenAddress, @symbol, @name, @chain,
        @marketCap, @liquidity, @holders, @progress, @status,
        @swaps24h, @buys24h, @sells24h, @netBuy24h,
        @rugRatio, @top10HolderRate, @isHoneypot,
        @renouncedMint, @renouncedFreezeAccount,
        @sniperCount, @smartDegenCount,
        @creator, @launchpad, @launchpadPlatform, @createdTimestamp,
        @rawJson, CURRENT_TIMESTAMP
    )
    ON CONFLICT(section, token_address) DO UPDATE SET
        symbol = excluded.symbol,
        name = excluded.name,
        chain = excluded.chain,
        market_cap = excluded.market_cap,
        liquidity = excluded.liquidity,
        holders = excluded.holders,
        progress = excluded.progress,
        status = excluded.status,
        swaps_24h = excluded.swaps_24h,
        buys_24h = excluded.buys_24h,
        sells_24h = excluded.sells_24h,
        net_buy_24h = excluded.net_buy_24h,
        rug_ratio = excluded.rug_ratio,
        top_10_holder_rate = excluded.top_10_holder_rate,
        is_honeypot = excluded.is_honeypot,
        renounced_mint = excluded.renounced_mint,
        renounced_freeze_account = excluded.renounced_freeze_account,
        sniper_count = excluded.sniper_count,
        smart_degen_count = excluded.smart_degen_count,
        creator = excluded.creator,
        launchpad = excluded.launchpad,
        launchpad_platform = excluded.launchpad_platform,
        created_timestamp = excluded.created_timestamp,
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

const LIST_COLUMNS = `
    id, section, token_address, symbol, name, chain,
    market_cap, liquidity, holders, progress, status,
    swaps_24h, buys_24h, sells_24h, net_buy_24h,
    rug_ratio, top_10_holder_rate, is_honeypot,
    renounced_mint, renounced_freeze_account,
    sniper_count, smart_degen_count,
    creator, launchpad, launchpad_platform, created_timestamp, updated_at
`;

function findBySection(section, limit = 50){

    return db.prepare(`
        SELECT ${LIST_COLUMNS} FROM gmgn_trenches
        WHERE section = ?
        ORDER BY market_cap DESC
        LIMIT ?
    `).all(section, limit);

}

function countAll(){

    return db.prepare("SELECT COUNT(*) as count FROM gmgn_trenches").get().count;

}

// Used by the Intelligence Engine to enrich a gmgn_tokens row with
// real security/risk fields when this token also happens to appear
// in the trenches feed. Most tokens won't (trenches only covers a
// few dozen recent launches at a time) - callers must treat a null
// result as genuinely "no data", not retry or guess.

function findByTokenAddress(tokenAddress){

    return db.prepare(`
        SELECT ${LIST_COLUMNS}, raw_json FROM gmgn_trenches
        WHERE token_address = ?
        ORDER BY updated_at DESC
        LIMIT 1
    `).get(tokenAddress);

}

module.exports = { upsertEntries, findBySection, countAll, findByTokenAddress };
