// collectors/gmgn/launchpadStatsCollector.js - collects token-count
// per launchpad platform from GET /v1/cooking/statistics.

const config = require("../../config/env");
const marketDataGateway = require("../../services/marketDataGateway");
const { withOrigin } = require("./gmgnTrafficAccounting");
const { transformResponse } = require("../../services/launchpadStatsTransformer");
const gmgnLaunchpadStatsRepository = require("../../repositories/gmgnLaunchpadStatsRepository");

async function collectLaunchpadStats(){

    if(!config.GMGN_API_KEY){

        throw new Error("GMGN_API_KEY is not set in server/.env.");

    }

    const result = await withOrigin("scheduler:launchpad_stats", () => marketDataGateway.getCookingStatistics());

    const entries = transformResponse(result.data);

    const upserted = gmgnLaunchpadStatsRepository.upsertEntries(entries);

    return { entriesReceived: entries.length, entriesUpserted: upserted };

}

module.exports = { collectLaunchpadStats };
