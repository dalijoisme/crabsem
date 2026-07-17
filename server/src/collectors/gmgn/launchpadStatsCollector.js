// collectors/gmgn/launchpadStatsCollector.js - collects token-count
// per launchpad platform from GET /v1/cooking/statistics.

const config = require("../../config/env");
const { createGmgnClient } = require("./authClient");
const { transformResponse } = require("../../services/launchpadStatsTransformer");
const gmgnLaunchpadStatsRepository = require("../../repositories/gmgnLaunchpadStatsRepository");

async function collectLaunchpadStats(){

    if(!config.GMGN_API_KEY){

        throw new Error("GMGN_API_KEY is not set in server/.env.");

    }

    const client = createGmgnClient({

        apiKey: config.GMGN_API_KEY,

        privateKeyPem: config.GMGN_PRIVATE_KEY,

        host: config.GMGN_HOST

    });

    const result = await client.getCookingStatistics();

    const entries = transformResponse(result.data);

    const upserted = gmgnLaunchpadStatsRepository.upsertEntries(entries);

    return { entriesReceived: entries.length, entriesUpserted: upserted };

}

module.exports = { collectLaunchpadStats };
