// collectors/gmgn/activityFeedCollector.js - collects real recent
// trades made by KOL-tagged and smart-money-tagged wallets (GET
// /v1/user/kol and /v1/user/smartmoney) and appends new ones (deduped
// by transaction_hash) into gmgn_activity_feed.

const config = require("../../config/env");
const { createGmgnClient } = require("./authClient");
const { transformResponse } = require("../../services/activityFeedTransformer");
const gmgnActivityFeedRepository = require("../../repositories/gmgnActivityFeedRepository");

const CHAIN = "sol";

function getClient(){

    if(!config.GMGN_API_KEY){

        throw new Error("GMGN_API_KEY is not set in server/.env.");

    }

    return createGmgnClient({

        apiKey: config.GMGN_API_KEY,

        privateKeyPem: config.GMGN_PRIVATE_KEY,

        host: config.GMGN_HOST

    });

}

async function collectKolActivity(){

    const client = getClient();

    const result = await client.getKolActivity(CHAIN, 50);

    const entries = transformResponse("kol", result.data);

    const inserted = gmgnActivityFeedRepository.insertEntries(entries);

    return { feedType: "kol", entriesReceived: entries.length, entriesInserted: inserted };

}

async function collectSmartMoneyActivity(){

    const client = getClient();

    const result = await client.getSmartMoneyActivity(CHAIN, 50);

    const entries = transformResponse("smart_money", result.data);

    const inserted = gmgnActivityFeedRepository.insertEntries(entries);

    return { feedType: "smart_money", entriesReceived: entries.length, entriesInserted: inserted };

}

module.exports = { collectKolActivity, collectSmartMoneyActivity };
