// repositories/userListsRepository.js - the only place that reads/
// writes user_watchlist and user_favorites. A token added here is
// never removed from gmgn_tokens/history just because it drops out of
// trending - these tables only ever reference token_address, so
// "the token disappeared from ranking" never breaks the reference.

const db = require("../database/connection");

function addTo(table, viewerWalletAddress, tokenAddress){

    db.prepare(`
        INSERT INTO ${table} (viewer_wallet_address, token_address)
        VALUES (?, ?)
        ON CONFLICT(viewer_wallet_address, token_address) DO NOTHING
    `).run(viewerWalletAddress, tokenAddress);

}

function removeFrom(table, viewerWalletAddress, tokenAddress){

    return db.prepare(`
        DELETE FROM ${table} WHERE viewer_wallet_address = ? AND token_address = ?
    `).run(viewerWalletAddress, tokenAddress).changes;

}

function listFor(table, viewerWalletAddress){

    return db.prepare(`
        SELECT token_address, added_at FROM ${table}
        WHERE viewer_wallet_address = ?
        ORDER BY added_at DESC
    `).all(viewerWalletAddress);

}

function isIn(table, viewerWalletAddress, tokenAddress){

    return Boolean(db.prepare(`
        SELECT 1 FROM ${table} WHERE viewer_wallet_address = ? AND token_address = ?
    `).get(viewerWalletAddress, tokenAddress));

}

// `table` is always one of these two literal, hardcoded constants -
// never derived from request input - so string-building the table
// name here carries no injection risk.

const WATCHLIST = "user_watchlist";
const FAVORITES = "user_favorites";

module.exports = {
    WATCHLIST,
    FAVORITES,
    addToWatchlist: (v,t) => addTo(WATCHLIST, v, t),
    removeFromWatchlist: (v,t) => removeFrom(WATCHLIST, v, t),
    listWatchlist: (v) => listFor(WATCHLIST, v),
    isInWatchlist: (v,t) => isIn(WATCHLIST, v, t),
    addToFavorites: (v,t) => addTo(FAVORITES, v, t),
    removeFromFavorites: (v,t) => removeFrom(FAVORITES, v, t),
    listFavorites: (v) => listFor(FAVORITES, v),
    isInFavorites: (v,t) => isIn(FAVORITES, v, t)
};
