// collectors/gmgn/activityFeedCollector.js - collects real recent
// trades made by KOL-tagged and smart-money-tagged wallets (GET
// /v1/user/kol and /v1/user/smartmoney) and appends new ones (deduped
// by transaction_hash) into gmgn_activity_feed.

const config = require("../../config/env");
const marketDataGateway = require("../../services/marketDataGateway");
const { transformResponse } = require("../../services/activityFeedTransformer");
const gmgnActivityFeedRepository = require("../../repositories/gmgnActivityFeedRepository");

const CHAIN = "sol";

function assertConfigured(){

    if(!config.GMGN_API_KEY){

        throw new Error("GMGN_API_KEY is not set in server/.env.");

    }

}

async function collectKolActivity(){

    assertConfigured();

    const result = await marketDataGateway.getKolActivity(CHAIN, 50);

    const entries = transformResponse("kol", result.data);

    const inserted = gmgnActivityFeedRepository.insertEntries(entries);

    return { feedType: "kol", entriesReceived: entries.length, entriesInserted: inserted };

}

async function collectSmartMoneyActivity(){

    assertConfigured();

    const result = await marketDataGateway.getSmartMoneyActivity(CHAIN, 50);

    const entries = transformResponse("smart_money", result.data);

    const inserted = gmgnActivityFeedRepository.insertEntries(entries);

    return { feedType: "smart_money", entriesReceived: entries.length, entriesInserted: inserted };

}

module.exports = { collectKolActivity, collectSmartMoneyActivity };
