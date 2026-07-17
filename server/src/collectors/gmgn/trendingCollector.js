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
const tokenPriceHistoryRepository = require("../../repositories/tokenPriceHistoryRepository");
const { transformTokens } = require("../../services/tokenTransformer");

const ENDPOINT = "market_rank";
const CHAIN = "sol";

// Scan-coverage fix (see the data-integrity/scan-coverage audit): the
// original code requested only interval=1h with no `limit`, so it
// silently got whatever GMGN's default page size is (empirically
// verified live: 10 rows). Empirically verified live against the
// real API:
//   - `limit` IS a real, respected GMGN param for this endpoint.
//   - GMGN caps it server-side at 100 regardless of a higher request
//     (tested 100/500/1000 -> all returned exactly 100).
//   - Different `interval` values return meaningfully different
//     top-100 sets, not the same tokens re-sorted (measured live
//     overlap between adjacent intervals: ~60-65%) - so requesting
//     several intervals and merging is a real coverage increase, not
//     padding. Four intervals at limit:100 measured a live union of
//     197 unique tokens vs. the original 10.
// No pagination cursor/page param was found - `page` was tested and
// had no effect (identical results to page-less), so this is the
// realistic ceiling without GMGN adding real cursor support.

const REQUEST_LIMIT = 100;
const INTERVALS = ["5m", "1h", "6h", "24h"];
const INTERVAL_SPACING_MS = 500;

function sleep(ms){

    return new Promise(resolve => setTimeout(resolve, ms));

}

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

    // 1 & 2: fetch each interval, saving every raw response as-is
    // (one gmgn_raw_snapshots row per interval per tick - still fully
    // auditable, just more rows than the single-interval version).

    const byAddress = new Map(); // first interval to see a token wins - see comment below
    let lastSnapshotId = null;
    let totalRawBytes = 0;
    let totalReceived = 0;

    for(let i = 0; i < INTERVALS.length; i++){

        const interval = INTERVALS[i];

        const requestParams = { chain: CHAIN, interval, limit: REQUEST_LIMIT };

        const result = await client.getTrendingSwaps(CHAIN, interval, { limit: REQUEST_LIMIT });

        lastSnapshotId = gmgnSnapshotRepository.insertSnapshot({

            endpoint: ENDPOINT,

            requestParams,

            rawResponse: result.raw

        });

        totalRawBytes += result.raw.length;

        // 3: transform. GMGN's /v1/market/rank wraps the token array as
        // { data: { data: { rank: [...] } } } - verified against a real
        // response, not assumed. Fail loudly if that shape ever changes
        // rather than silently proceeding with the wrong data.

        const rankArray = result.data?.data?.rank;

        if(!Array.isArray(rankArray)){

            throw new Error(
                `Unexpected GMGN response shape for ${ENDPOINT} (interval=${interval}): expected ` +
                `data.data.rank to be an array, got: ${JSON.stringify(result.data).slice(0, 300)}`
            );

        }

        totalReceived += rankArray.length;

        // Merge: a token seen at a shorter interval (5m) is fresher-
        // momentum data than the same token seen only at 24h, so the
        // first interval in INTERVALS order that has it wins - later
        // intervals only fill in tokens not already captured.

        for(const raw of rankArray){

            if(raw?.address && !byAddress.has(raw.address)) byAddress.set(raw.address, raw);

        }

        if(i < INTERVALS.length - 1) await sleep(INTERVAL_SPACING_MS);

    }

    const tokens = transformTokens([...byAddress.values()]);

    // 4: upsert.

    const tokensUpserted = gmgnTokenRepository.upsertTokens(tokens);

    // 5: real per-token price history, one row per token per tick -
    // the ground truth the recommendation validation framework
    // (recommendationLogRepository / token_price_history) evaluates
    // outcomes against later. Same real numbers just written to
    // gmgn_tokens, not a second fetch or a derived estimate.

    tokenPriceHistoryRepository.insertMany(tokens.map(t => ({

        tokenAddress: t.tokenAddress,

        price: t.price,

        marketCap: t.marketCap,

        liquidity: t.liquidity

    })));

    return {

        snapshotId: lastSnapshotId,

        endpoint: ENDPOINT,

        intervals: INTERVALS,

        rawBytes: totalRawBytes,

        tokensReceivedAcrossIntervals: totalReceived,

        uniqueTokensMerged: tokens.length,

        tokensUpserted

    };

}

module.exports = { collectTrending };
