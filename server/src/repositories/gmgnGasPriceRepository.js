// repositories/gmgnGasPriceRepository.js - the only place that
// reads/writes gmgn_gas_price_snapshots. Append-only time series.

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO gmgn_gas_price_snapshots (
        chain, auto_fee, high_fee, average_fee, low_fee,
        native_token_usd_price, raw_json
    ) VALUES (
        @chain, @autoFee, @highFee, @averageFee, @lowFee,
        @nativeTokenUsdPrice, @rawJson
    )
`);

function insertSnapshot(entry){

    const info = insertStmt.run(entry);

    return info.lastInsertRowid;

}

function getLatest(chain){

    return db.prepare(`
        SELECT * FROM gmgn_gas_price_snapshots
        WHERE chain = ?
        ORDER BY id DESC
        LIMIT 1
    `).get(chain);

}

function getRecent(chain, limit = 50){

    return db.prepare(`
        SELECT * FROM gmgn_gas_price_snapshots
        WHERE chain = ?
        ORDER BY id DESC
        LIMIT ?
    `).all(chain, limit);

}

module.exports = { insertSnapshot, getLatest, getRecent };
