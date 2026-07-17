// services/walletLedgerService.js - builds the REAL wallet trade
// ledger. GMGN never hands over a per-wallet transaction history
// directly (its activity feeds are real but only per-token/per-tag
// snapshots) - this derives one from the real KOL/smart-money trade
// rows already flowing into gmgn_activity_feed, by FIFO-matching each
// wallet+token's buys to its subsequent sells. No GMGN calls happen
// here at all - this only reads what the existing collectors already
// stored, so it costs zero extra API quota.
//
// A sell with no matching prior buy in our own observed window is
// real too (a genuine trade happened) but we have no real entry price
// for it - rather than fabricate one, that trade is simply not turned
// into a scored position. Silence, not a guess.

const db = require("../database/connection");
const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const walletRepository = require("../repositories/walletRepository");
const walletTradePositionRepository = require("../repositories/walletTradePositionRepository");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");

function toIso(unixSeconds){

    if(!unixSeconds) return null;

    return new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 19).replace("T", " ");

}

function estimateMarketCapAt(tokenAddress, isoTime){

    // Best-effort enrichment only - token_price_history only exists
    // from this platform's own collection forward, so older activity
    // rows will often have nothing here. Null, never guessed.
    const point = tokenPriceHistoryRepository.findPriceAtOrAfter(tokenAddress, isoTime);

    return point ? point.market_cap : null;

}

// Processes every not-yet-matched gmgn_activity_feed row (kol +
// smart_money) in chronological order, building/updating
// wallet_trade_positions and registering every wallet seen.

function buildLedgerFromActivityFeed(){

    const sinceId = walletTradePositionRepository.getMaxMatchedActivityId();

    const rows = db.prepare(`
        SELECT id, feed_type, maker_address, token_address, token_symbol, side, amount_usd, price_usd, tx_timestamp
        FROM gmgn_activity_feed
        WHERE id > ? AND maker_address IS NOT NULL AND token_address IS NOT NULL AND side IS NOT NULL
        ORDER BY tx_timestamp ASC, id ASC
    `).all(sinceId);

    if(!rows.length) return { processed: 0, opened: 0, closed: 0, unmatched: 0, walletsSeen: 0 };

    const walletTouch = new Map(); // wallet_address -> { firstSeen, lastSeen, kol, smartMoney }

    let opened = 0, closed = 0, unmatched = 0;

    const run = db.transaction(() => {

        for(const row of rows){

            const iso = toIso(row.tx_timestamp);

            const touch = walletTouch.get(row.maker_address) || { firstSeen: iso, lastSeen: iso, kol: 0, smartMoney: 0 };

            if(iso && (!touch.firstSeen || iso < touch.firstSeen)) touch.firstSeen = iso;

            if(iso && (!touch.lastSeen || iso > touch.lastSeen)) touch.lastSeen = iso;

            if(row.feed_type === "kol") touch.kol = 1;

            if(row.feed_type === "smart_money") touch.smartMoney = 1;

            walletTouch.set(row.maker_address, touch);

            if(row.side === "buy"){

                walletTradePositionRepository.openPosition({

                    walletAddress: row.maker_address,

                    tokenAddress: row.token_address,

                    tokenSymbol: row.token_symbol,

                    entryTime: iso,

                    entryPrice: row.price_usd,

                    entryMarketCap: estimateMarketCapAt(row.token_address, iso),

                    entryAmountUsd: row.amount_usd,

                    entryActivityId: row.id

                });

                opened++;

            }
            else if(row.side === "sell"){

                const open = walletTradePositionRepository.findOldestOpenPosition(row.maker_address, row.token_address);

                if(!open){ unmatched++; continue; }

                const entryMs = open.entry_time ? new Date(`${open.entry_time.replace(" ","T")}Z`).getTime() : null;

                const exitMs = iso ? new Date(`${iso.replace(" ","T")}Z`).getTime() : null;

                const holdingSeconds = (entryMs != null && exitMs != null) ? Math.max(0, (exitMs - entryMs) / 1000) : null;

                const roiPct = (open.entry_price != null && Number(open.entry_price) > 0 && row.price_usd != null)
                    ? ((Number(row.price_usd) - Number(open.entry_price)) / Number(open.entry_price)) * 100
                    : null;

                const profitUsd = (open.entry_amount_usd != null && row.amount_usd != null)
                    ? Number(row.amount_usd) - Number(open.entry_amount_usd)
                    : null;

                walletTradePositionRepository.closePosition({

                    id: open.id,

                    exitTime: iso,

                    exitPrice: row.price_usd,

                    exitMarketCap: estimateMarketCapAt(row.token_address, iso),

                    exitAmountUsd: row.amount_usd,

                    holdingSeconds,

                    roiPct,

                    profitUsd,

                    exitActivityId: row.id

                });

                closed++;

            }

        }

    });

    run();

    const wallets = [...walletTouch.entries()].map(([walletAddress, t]) => ({

        walletAddress,

        chain: "sol",

        firstSeen: t.firstSeen,

        lastSeen: t.lastSeen,

        sourceKol: t.kol,

        sourceSmartMoney: t.smartMoney,

        sourceDevWallet: 0,

        sourceTopTrader: 0

    }));

    walletRepository.upsertManyWallets(wallets);

    return { processed: rows.length, opened, closed, unmatched, walletsSeen: wallets.length };

}

// Registers real developer/creator wallets from gmgn_trenches - a
// genuinely different real signal from trade activity (being a token
// creator, not a trader), so these wallets exist in the `wallets`
// table even with zero trade positions.

function registerDevWallets(){

    const creators = db.prepare(`
        SELECT DISTINCT creator FROM gmgn_trenches WHERE creator IS NOT NULL
    `).all().map(r => r.creator);

    if(!creators.length) return { registered: 0 };

    walletRepository.upsertManyWallets(creators.map(address => ({

        walletAddress: address,

        chain: "sol",

        firstSeen: null,

        lastSeen: null,

        sourceKol: 0,

        sourceSmartMoney: 0,

        sourceDevWallet: 1,

        sourceTopTrader: 0

    })));

    return { registered: creators.length };

}

module.exports = { buildLedgerFromActivityFeed, registerDevWallets };
