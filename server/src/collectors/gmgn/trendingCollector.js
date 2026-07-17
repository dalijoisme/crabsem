// collectors/gmgn/trendingCollector.js - the first GMGN collector.
//
// Flow: GMGN -> receive JSON -> save raw response into
// gmgn_raw_snapshots (debugging/history, unchanged) -> transform ->
// upsert into gmgn_tokens (structured, queryable). Nothing in
// routes/ or app.js imports this file, and this file never imports
// routes/ or app.js: the data flow is GMGN -> Collector -> Database,
// never Collector -> Dashboard.

const config = require("../../config/env");
const { createGmgnClient } = require("./authClient");
const gmgnSnapshotRepository = require("../../repositories/gmgnSnapshotRepository");
const gmgnTokenRepository = require("../../repositories/gmgnTokenRepository");
const { transformTokens } = require("../../services/tokenTransformer");

const ENDPOINT = "market_rank";
const CHAIN = "sol";
const INTERVAL = "1h";

async function collectTrending(){

    if(!config.GMGN_API_KEY){

        throw new Error(
            "GMGN_API_KEY is not set in server/.env. Run `npm run gmgn:generate-keys`, " +
            "register the printed public key at https://gmgn.ai/ai, then set " +
            "GMGN_API_KEY in server/.env."
        );

    }

    const client = createGmgnClient({

        apiKey: config.GMGN_API_KEY,

        privateKeyPem: config.GMGN_PRIVATE_KEY,

        host: config.GMGN_HOST

    });

    const requestParams = { chain: CHAIN, interval: INTERVAL };

    // 1 & 2: receive JSON, save the raw response as-is.

    const result = await client.getTrendingSwaps(CHAIN, INTERVAL);

    const snapshotId = gmgnSnapshotRepository.insertSnapshot({

        endpoint: ENDPOINT,

        requestParams,

        rawResponse: result.raw

    });

    // 3: transform. GMGN's /v1/market/rank wraps the token array as
    // { data: { data: { rank: [...] } } } - verified against a real
    // response, not assumed. Fail loudly if that shape ever changes
    // rather than silently proceeding with the wrong data.

    const rankArray = result.data?.data?.rank;

    if(!Array.isArray(rankArray)){

        throw new Error(
            `Unexpected GMGN response shape for ${ENDPOINT}: expected data.data.rank ` +
            `to be an array, got: ${JSON.stringify(result.data).slice(0, 300)}`
        );

    }

    const tokens = transformTokens(rankArray);

    // 4: upsert.

    const tokensUpserted = gmgnTokenRepository.upsertTokens(tokens);

    return {

        snapshotId,

        endpoint: ENDPOINT,

        requestParams,

        rawBytes: result.raw.length,

        tokensReceived: rankArray.length,

        tokensUpserted

    };

}

module.exports = { collectTrending };
