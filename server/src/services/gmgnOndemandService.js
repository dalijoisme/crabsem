// services/gmgnOndemandService.js - fetches per-token/per-wallet
// GMGN data live, caching real responses in gmgn_ondemand_cache (via
// gmgnOndemandCacheRepository) so repeated requests for the same
// token/wallet within the TTL window don't re-hit GMGN. Never
// fabricates a response - a cache miss always means a real live
// GMGN call, and a failure is surfaced as a real error, not a
// silent fallback.

const config = require("../config/env");
const { createGmgnClient } = require("../collectors/gmgn/authClient");
const gmgnOndemandCacheRepository = require("../repositories/gmgnOndemandCacheRepository");

const DEFAULT_TTL_SECONDS = 60;

function getClient(){

    if(!config.GMGN_API_KEY){

        throw Object.assign(new Error("GMGN_API_KEY is not set in server/.env."), { status: 503 });

    }

    return createGmgnClient({

        apiKey: config.GMGN_API_KEY,

        privateKeyPem: config.GMGN_PRIVATE_KEY,

        host: config.GMGN_HOST

    });

}

async function fetchCached({ endpoint, params, ttlSeconds = DEFAULT_TTL_SECONDS, fetcher }){

    const cacheKey = `${endpoint}:${JSON.stringify(params)}`;

    const cached = gmgnOndemandCacheRepository.get(cacheKey);

    if(cached) return cached;

    const client = getClient();

    const result = await fetcher(client);

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

function getTokenPoolInfo(chain, address){

    return fetchCached({

        endpoint: "token_pool_info",

        params: { chain, address },

        ttlSeconds: 60,

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

function getTokenKline(chain, address, resolution){

    return fetchCached({

        endpoint: "token_kline",

        params: { chain, address, resolution },

        ttlSeconds: 60,

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
