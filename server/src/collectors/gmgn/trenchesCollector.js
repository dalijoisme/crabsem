// collectors/gmgn/trenchesCollector.js - collects new_creation /
// near_completion(pump) / completed Solana token launches from
// POST /v1/trenches and upserts them into gmgn_trenches.

const config = require("../../config/env");
const { createGmgnClient } = require("./authClient");
const { buildTrenchesBody } = require("./trenchesRequestBuilder");
const { transformResponse } = require("../../services/trenchesTransformer");
const gmgnTrenchesRepository = require("../../repositories/gmgnTrenchesRepository");

const CHAIN = "sol";

async function collectTrenches(){

    if(!config.GMGN_API_KEY){

        throw new Error("GMGN_API_KEY is not set in server/.env.");

    }

    const client = createGmgnClient({

        apiKey: config.GMGN_API_KEY,

        privateKeyPem: config.GMGN_PRIVATE_KEY,

        host: config.GMGN_HOST

    });

    const body = buildTrenchesBody(CHAIN, { limit: 30 });

    const result = await client.getTrenches(CHAIN, body);

    const entries = transformResponse(result.data);

    const upserted = gmgnTrenchesRepository.upsertEntries(entries);

    return { chain: CHAIN, entriesReceived: entries.length, entriesUpserted: upserted };

}

module.exports = { collectTrenches };
