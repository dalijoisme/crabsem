// services/launchpadStatsTransformer.js - converts GMGN's
// /v1/cooking/statistics response into rows for
// gmgnLaunchpadStatsRepository. Field verified live is literally
// "launchapd" (GMGN's own typo, not ours) - kept as the source key
// here, mapped to a correctly-spelled column in our schema.

function transformResponse(responseData){

    const list = Array.isArray(responseData) ? responseData : [];

    return list.map(item => ({

        launchpad: item.launchapd ?? item.launchpad ?? null,

        tokenCount: item.token_count != null ? Number(item.token_count) : null

    })).filter(e => e.launchpad);

}

module.exports = { transformResponse };
