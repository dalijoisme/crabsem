// collectors/dexscreener/dexscreenerClient.js - minimal client for
// DexScreener's public, unauthenticated REST API. Used ONLY as the
// Global Search fallback (see services/globalSearchService.js) for a
// token that isn't already in gmgn_tokens - GMGN's own API (see
// collectors/gmgn/authClient.js) has no "look up one token by
// address/name" endpoint, only trending/rank-list and per-token
// on-demand facts (security/pool_info/top_holders/etc, which assume
// the token is already known). DexScreener indexes every Solana pair
// directly, keyed by contract address or free text, with no API key
// required - exactly what global search needs.
//
// Real data only: a network failure or empty result is surfaced as
// such (empty array / thrown error) - never a fabricated pair.

const BASE_URL = "https://api.dexscreener.com";

const FETCH_TIMEOUT_MS = 8000;

async function fetchJson(url){

    const controller = new AbortController();

    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try{

        const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "crabsem-server/0.1.0" } });

        if(!res.ok){

            throw Object.assign(new Error(`DexScreener request failed: HTTP ${res.status}`), { status: res.status });

        }

        return await res.json();

    }
    finally{

        clearTimeout(timeout);

    }

}

// GET /latest/dex/tokens/:addresses - up to 30 comma-separated
// contract addresses. Returns every pair DexScreener has indexed for
// those addresses across every chain/DEX - callers filter to
// chainId === "solana" themselves (see globalSearchService.js).

async function getPairsByTokenAddress(address){

    const data = await fetchJson(`${BASE_URL}/latest/dex/tokens/${encodeURIComponent(address)}`);

    return data?.pairs || [];

}

// GET /latest/dex/search?q= - free-text search across DexScreener's
// full index (name/symbol match), same response shape as above.

async function searchPairs(query){

    const data = await fetchJson(`${BASE_URL}/latest/dex/search?q=${encodeURIComponent(query)}`);

    return data?.pairs || [];

}

module.exports = { getPairsByTokenAddress, searchPairs };
