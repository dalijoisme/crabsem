// collectors/gmgn/hotSearchesCollector.js - collects the most-
// searched Solana tokens from POST /v1/market/hot_searches and
// upserts them into gmgn_hot_searches.

const config = require("../../config/env");
const marketDataGateway = require("../../services/marketDataGateway");
const { transformResponse } = require("../../services/hotSearchesTransformer");
const gmgnHotSearchesRepository = require("../../repositories/gmgnHotSearchesRepository");

const CHAIN = "sol";
const INTERVAL = "24h";

async function collectHotSearches(){

    if(!config.GMGN_API_KEY){

        throw new Error("GMGN_API_KEY is not set in server/.env.");

    }

    const result = await marketDataGateway.getHotSearches([

        { label: "hot-search", chain: CHAIN, interval: INTERVAL }

    ]);

    const entries = transformResponse(result.data);

    const upserted = gmgnHotSearchesRepository.upsertEntries(entries);

    return { chain: CHAIN, interval: INTERVAL, entriesReceived: entries.length, entriesUpserted: upserted };

}

module.exports = { collectHotSearches };
