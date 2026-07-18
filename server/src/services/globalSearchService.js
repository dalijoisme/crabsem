// services/globalSearchService.js - GLOBAL SEARCH (engine-quality
// sprint, Critical Issue #1). Previous behavior only ever searched
// gmgn_tokens - whatever GMGN's own trending/rank feed happened to
// have already surfaced - so any Solana token outside that feed was
// simply unfindable. That is now only the FIRST step:
//
//   search local cache (gmgn_tokens, unchanged/instant)
//        |
//        v (only if nothing real matched)
//   fetch real data from DexScreener (GMGN's own API has no
//   look-up-by-address/name endpoint - see collectors/gmgn/
//   authClient.js's doc comment - only trending-list and per-token
//   on-demand facts that assume the token is already known)
//        |
//        v
//   persist into gmgn_tokens (upsertToken) - the SAME table
//   monitored tokens live in, so this one write is also what makes
//   Watch Later / Favorites / Recently Viewed work identically for a
//   globally-searched token: those tables only ever reference
//   token_address (see userListsRepository.js's own doc comment) and
//   join back to gmgn_tokens at read time - no separate code path
//   needed.
//        |
//        v
//   analyzeToken() (Intelligence Engine) + tradePlanService, exactly
//   like any monitored token - never a separate/fabricated result
//   shape.
//
// A token discovered this way naturally has less real data available
// than one GMGN has tracked for a while (no trenches/smart-money/KOL
// history yet, no holder count - DexScreener's public API doesn't
// return one) - the engine already handles that honestly via its
// existing hasData:false / neutral-score convention; nothing here
// fabricates a number those sources don't actually provide.

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const intelligenceEngine = require("./intelligenceEngine");
const dexscreenerClient = require("../collectors/dexscreener/dexscreenerClient");
const dexscreenerTransformer = require("../services/dexscreenerTransformer");

// Solana addresses are base58 (no 0/O/I/l), 32-44 characters. Used
// only to decide HOW to query DexScreener (by-address vs free-text
// search) - never to validate correctness of an actual on-chain
// address, which only the chain itself can do.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isAddressLike(query){

    return SOLANA_ADDRESS_RE.test(query.trim());

}

function attachSignals(tokens){

    const signals = intelligenceEngine.analyzeTokens(tokens);

    return tokens.map((token, i) => ({ ...token, signal: signals[i] }));

}

// Picks one real pair per base token address (a token can have many
// pools/DEXes indexed) - the highest-liquidity pair is the most
// representative real market snapshot for that token.

function bestPairPerToken(pairs){

    const byAddress = new Map();

    for(const pair of pairs){

        if(pair.chainId !== "solana") continue;

        const addr = pair.baseToken?.address;

        if(!addr) continue;

        const liq = Number(pair.liquidity?.usd || 0);

        const existing = byAddress.get(addr);

        if(!existing || liq > Number(existing.liquidity?.usd || 0)){

            byAddress.set(addr, pair);

        }

    }

    return [...byAddress.values()];

}

async function fetchLiveCandidates(query){

    try{

        const pairs = isAddressLike(query)
            ? await dexscreenerClient.getPairsByTokenAddress(query.trim())
            : await dexscreenerClient.searchPairs(query);

        return bestPairPerToken(pairs);

    }
    catch(err){

        console.error(`[globalSearch] DexScreener lookup failed for "${query}": ${err.message}`);

        return [];

    }

}

// Persists every live-discovered candidate (so it behaves exactly
// like a monitored token from this point on - watchlist/favorites/
// recently-viewed, detail view, trade plan, all "just work") and
// returns the canonical rows back out of gmgn_tokens.

function persistCandidates(pairs){

    if(!pairs.length) return [];

    const rows = pairs.map(dexscreenerTransformer.transformPair).filter(r => r.tokenAddress);

    gmgnTokenRepository.upsertTokens(rows);

    return rows

        .map(r => gmgnTokenRepository.getTokenByAddress(r.tokenAddress))

        .filter(Boolean);

}

async function search(query, limit){

    const localTokens = gmgnTokenRepository.findMany({

        limit,

        offset: 0,

        sortColumn: "market_cap",

        direction: "DESC",

        search: query

    });

    if(localTokens.length){

        return { query, tokens: attachSignals(localTokens), source: "local" };

    }

    const candidates = await fetchLiveCandidates(query);

    const liveTokens = persistCandidates(candidates.slice(0, limit));

    return { query, tokens: attachSignals(liveTokens), source: liveTokens.length ? "live" : "none" };

}

module.exports = { search, isAddressLike };
