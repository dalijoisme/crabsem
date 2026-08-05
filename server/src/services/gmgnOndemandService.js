// services/gmgnOndemandService.js - fetches per-token/per-wallet
// GMGN data live, caching real responses in gmgn_ondemand_cache (via
// gmgnOndemandCacheRepository) so repeated requests for the same
// token/wallet within the TTL window don't re-hit GMGN. Never
// fabricates a response - a cache miss always means a real live
// GMGN call, and a failure is surfaced as a real error, not a
// silent fallback.
//
// Held-Position Refresh Architecture, Phase 1: the live GMGN call on a
// cache miss now goes through services/marketDataGateway.js - the one
// and only door to GMGN market data - instead of building its own
// collectors/gmgn/authClient.js client. This file's own DB-backed TTL
// cache (gmgnOndemandCacheRepository) is unchanged; the gateway adds
// in-flight request coalescing underneath it for the case this cache
// doesn't already catch - two callers racing a cache miss for the same
// token/wallet at nearly the same instant.

const gmgnOndemandCacheRepository = require("../repositories/gmgnOndemandCacheRepository");
const marketDataGateway = require("./marketDataGateway");

const DEFAULT_TTL_SECONDS = 60;

async function fetchCached({ endpoint, params, ttlSeconds = DEFAULT_TTL_SECONDS, fetcher }){

    const cacheKey = `${endpoint}:${JSON.stringify(params)}`;

    const cached = gmgnOndemandCacheRepository.get(cacheKey);

    if(cached) return cached;

    const result = await fetcher(marketDataGateway);

    gmgnOndemandCacheRepository.set({

        cacheKey,

        endpoint,

        params,

        response: result.data,

        ttlSeconds

    });

    return { data: result.data, fetchedAt: new Date().toISOString(), cacheHit: false };

}

// ---- Token (on-demand) ----

function getTokenSecurity(chain, address){

    return fetchCached({

        endpoint: "token_security",

        params: { chain, address },

        ttlSeconds: 120,

        fetcher: client => client.getTokenSecurity(chain, address)

    });

}

// ttlSeconds is overridable (default unchanged at 60s, every existing
// caller unaffected) - Exit Engine realtime-latency fix
// (services/tradingBotEngine.js's refreshStaleHeldToken): an OPEN
// position already at/above its own take-profit floor needs this cache
// to expire close to that user's own configured
// exit_evaluation_interval_seconds (as low as 1s), never the 60s default
// built for occasional dashboard/wallet-intelligence lookups - otherwise
// re-checking every exit cycle just replays the same 60s-old cached
// response instead of ever fetching a genuinely newer price.
function getTokenPoolInfo(chain, address, ttlSeconds = 60){

    return fetchCached({

        endpoint: "token_pool_info",

        params: { chain, address },

        ttlSeconds,

        fetcher: client => client.getTokenPoolInfo(chain, address)

    });

}

function getTokenTopHolders(chain, address){

    return fetchCached({

        endpoint: "token_top_holders",

        params: { chain, address },

        ttlSeconds: 60,

        fetcher: client => client.getTokenTopHolders(chain, address)

    });

}

function getTokenTopTraders(chain, address){

    return fetchCached({

        endpoint: "token_top_traders",

        params: { chain, address },

        ttlSeconds: 60,

        fetcher: client => client.getTokenTopTraders(chain, address)

    });

}

// ttlSeconds overridable - see getTokenPoolInfo's own comment above.
function getTokenKline(chain, address, resolution, ttlSeconds = 60){

    return fetchCached({

        endpoint: "token_kline",

        params: { chain, address, resolution },

        ttlSeconds,

        fetcher: client => client.getTokenKline(chain, address, resolution)

    });

}

// ---- Wallet (on-demand) ----

function getWalletActivity(chain, walletAddress){

    return fetchCached({

        endpoint: "wallet_activity",

        params: { chain, walletAddress },

        ttlSeconds: 60,

        fetcher: client => client.getWalletActivity(chain, walletAddress)

    });

}

function getWalletStats(chain, walletAddress){

    return fetchCached({

        endpoint: "wallet_stats",

        params: { chain, walletAddress },

        ttlSeconds: 60,

        fetcher: client => client.getWalletStats(chain, [walletAddress])

    });

}

function getWalletTokenBalance(chain, walletAddress, tokenAddress){

    return fetchCached({

        endpoint: "wallet_token_balance",

        params: { chain, walletAddress, tokenAddress },

        ttlSeconds: 30,

        fetcher: client => client.getWalletTokenBalance(chain, walletAddress, tokenAddress)

    });

}

function getWalletHoldings(chain, walletAddress){

    return fetchCached({

        endpoint: "wallet_holdings",

        params: { chain, walletAddress },

        ttlSeconds: 30,

        fetcher: client => client.getWalletHoldings(chain, walletAddress)

    });

}

function getCreatedTokens(chain, walletAddress){

    return fetchCached({

        endpoint: "created_tokens",

        params: { chain, walletAddress },

        ttlSeconds: 120,

        fetcher: client => client.getCreatedTokens(chain, walletAddress)

    });

}

module.exports = {

    getTokenSecurity,

    getTokenPoolInfo,

    getTokenTopHolders,

    getTokenTopTraders,

    getTokenKline,

    getWalletActivity,

    getWalletStats,

    getWalletTokenBalance,

    getWalletHoldings,

    getCreatedTokens

};
