// =========================================
// CRAB AGENT API V6.2
// DexScreener ONLY (free, no API key, no paid tier)
//
// V6.2: every discovery endpoint below was verified TWICE -
// once against the official reference (docs.dexscreener.com/
// api/reference) and once with a live fetch that returned
// real data - before being kept. "Latest Ads"
// (ads/latest/v1) was removed even though the endpoint
// itself is real and reachable: URLs containing "/ads/" are
// a textbook pattern for browser ad-blocker filter lists
// (uBlock, Brave Shields, etc) regardless of the actual
// domain, so it's the kind of source that can silently fail
// for a meaningful share of real users. Not worth it for one
// of six sources.
//
// Also: a single discovery source failing (network blip,
// ad-blocker, DNS, temporary outage) now logs as
// console.warn, not console.error. It was already handled
// gracefully - the pipeline continues with whatever sources
// did succeed - so it shouldn't read as an application error
// in DevTools. console.error is reserved for genuine
// pipeline-level failures (search()/trending() themselves
// throwing), which are worth surfacing loudly.
//
// V6.1: discovery expanded from 3 to 7 real market-observation
// sources, verified one-by-one against DexScreener's official
// API reference rather than guessed:
//   - Boosted (Latest) / Boosted (Top)   [already had]
//   - New Token Profiles                 [already had,
//     RENAMED from "Recently Updated" - that name was wrong,
//     this endpoint is actually newest-created profiles]
//   - Recently Updated Profiles          [the real
//     recent-updates endpoint this was previously missing]
//   - Community Takeovers
//   - Trending Metas                     [genuinely
//     market-driven: DexScreener computes which narratives/
//     categories are trending right now, we just read the
//     result and pull pairs from the top ones. This is NOT
//     keyword search - we never choose the terms, the market
//     does, via DexScreener's own trending computation]
//
// There is still no bulk "all Solana pairs" or paginated
// firehose endpoint in DexScreener's free API - that ceiling
// has not changed. Reaching genuinely "thousands" would still
// need a paid/keyed provider (Birdeye, Helius DAS, Jupiter,
// Pump.fun) added as one more DISCOVERY_SOURCES entry -
// architecture already supports that without a redesign (see
// DISCOVERY_SOURCES below).
//
// Keyword search (DEX_SEARCH_URL) is still intentionally
// excluded from DISCOVERY_SOURCES - it only powers the manual
// search box, never auto-discovery.
//
// Birdeye Worker itself has been removed entirely (its
// compute units were exhausted, every call returned HTTP
// 500). DexScreener's public endpoints already covered every
// field we used Birdeye for (liquidity, volume, fdv,
// marketCap, priceChange, txns), so nothing numeric is
// "faked" here - it's the same data shape, from one real
// free source. The one thing genuinely lost: Birdeye was our
// only source for raw holder COUNT. `pair.holder` is always
// null now - Engine already treats that as neutral, and the
// UI already renders "-" for it.
//
// DexScreener already indexes Pump.fun / PumpSwap pairs once
// they have any pool (dexId shows "pumpfun" / "pumpswap"),
// so that coverage comes along automatically.
// =========================================

const DEX_BOOSTS_LATEST_URL =
    "https://api.dexscreener.com/token-boosts/latest/v1";

const DEX_BOOSTS_TOP_URL =
    "https://api.dexscreener.com/token-boosts/top/v1";

const DEX_PROFILES_LATEST_URL =
    "https://api.dexscreener.com/token-profiles/latest/v1";

const DEX_PROFILES_RECENT_UPDATES_URL =
    "https://api.dexscreener.com/token-profiles/recent-updates/v1";

const DEX_COMMUNITY_TAKEOVERS_URL =
    "https://api.dexscreener.com/community-takeovers/latest/v1";

const DEX_METAS_TRENDING_URL =
    "https://api.dexscreener.com/metas/trending/v1";

function metaDetailUrl(slug){

    return `https://api.dexscreener.com/metas/meta/v1/${encodeURIComponent(slug)}`;

}

const DEX_TOKENS_URL =
    "https://api.dexscreener.com/latest/dex/tokens/";

const DEX_SEARCH_URL =
    "https://api.dexscreener.com/latest/dex/search/?q=";

const DEX_BATCH_SIZE = 30;

// How many discovery results are shown
// (quality-first, not a flood of coins - but raised
// from 40 to 100 since the real quality gate is now
// Engine's score/action, not just this cap)
const DISCOVERY_LIMIT = 100;

// Reuse the last successful trending() result for a
// short window. This absorbs rapid repeat calls (e.g.
// clearing the search box a few times in a row) without
// hitting DexScreener again for the exact same data.
const TRENDING_CACHE_TTL = 20000;

let trendingCache = { data:null, ts:0 };

// =========================================
// SESSION PRICE HISTORY (real samples, in-memory)
//
// Every genuine trending() fetch (not cache hits) records
// a {time, price, liquidity, trades24h} snapshot per token
// address. After 3+ snapshots accumulate, Engine can look
// at real higher/lower price steps and liquidity trend
// across the session - not fabricated, just coarse (one
// sample per scan interval) and lost on page reload.
// =========================================

const PRICE_HISTORY = {};

const HISTORY_MAX_SAMPLES = 6;

function recordPriceHistory(pairs){

    const now = Date.now();

    pairs.forEach(pair=>{

        const address = pair.baseToken?.address;

        if(!address) return;

        const sample = {

            t: now,

            price: Number(pair.priceUsd || 0),

            liquidity: Number(pair.liquidity?.usd || 0),

            trades24h: pair.trades?.h24 ?? null

        };

        if(!PRICE_HISTORY[address]){

            PRICE_HISTORY[address] = [];

        }

        PRICE_HISTORY[address].push(sample);

        if(PRICE_HISTORY[address].length > HISTORY_MAX_SAMPLES){

            PRICE_HISTORY[address].shift();

        }

        pair.__priceHistory = PRICE_HISTORY[address];

    });

}

// =========================================
// REAL CONNECTIVITY / HEALTH STATUS
// (no hardcoded "Healthy" - reflects actual
// fetch outcomes of the last cycle, DexScreener
// only now)
// =========================================

const API_STATUS = {

    dexTokens:"unknown",

    lastError:null,
    lastUpdated:null

};

// Health is computed from whatever discovery sources are
// actually registered (see DISCOVERY_SOURCES below), so
// adding or removing a source never requires touching this
// function.

function computeHealth(){

    const sourceKeys =
        DISCOVERY_SOURCES.map(s=>s.statusKey);

    const discoverySignals =
        sourceKeys.map(k=>API_STATUS[k]);

    const anyDiscoveryOk =
        discoverySignals.some(s=>s==="ok");

    const allDiscoveryFail =
        discoverySignals.length>0 &&
        discoverySignals.every(s=>s==="error");

    const someDiscoveryFail =
        discoverySignals.some(s=>s==="error");

    if(allDiscoveryFail || API_STATUS.dexTokens==="error"){

        return{ engine:"Offline", live:"OFFLINE" };

    }

    if(!anyDiscoveryOk || someDiscoveryFail || API_STATUS.dexTokens==="partial"){

        return{ engine:"Warning", live:"LIMITED" };

    }

    return{ engine:"Healthy", live:"LIVE" };

}

// =========================================
// NON-MEME TOKEN LISTS
// (unchanged - discovery algorithm untouched,
// only used by trending(), not by search())
// =========================================

const SYMBOL_BLACKLIST = [

    "SOL","WSOL",

    "WBTC","WETH","WBNB","WAVAX","WMATIC",
    "SOETH","SOBTC","RENBTC",

    "USDC","USDT","DAI","USDH","UXD","USDE",
    "PYUSD","FDUSD","TUSD","USDY","SUSD","USDS","EURC",

    "MSOL","JITOSOL","BSOL","STSOL","SCNSOL","JSOL",
    "LST","INF","HSOL","DSOL","VSOL","PSOL",
    "BONKSOL","LAINESOL","COMPASSSOL","EDGESOL",
    "PHASESOL","JUPSOL","PWRSOL","HUBSOL","PICOSOL",

    "RAY","ORCA","JUP","JTO","PYTH","W","TNSR",
    "DRIFT","KMNO","MNDE","HNT","MOBILE","IOT",
    "RENDER","STEP","SBR","MPLX","MET","SRM","FIDA"

];

const NAME_KEYWORD_BLACKLIST = [

    "staked",
    "liquid staking",
    "restaked",
    "wrapped",
    "bridged",
    "liquid stake"

];

function isNonMemeToken(pair){

    const symbol =
        (pair.baseToken?.symbol || "")
        .toUpperCase();

    if(SYMBOL_BLACKLIST.includes(symbol))
        return true;

    const name =
        (pair.baseToken?.name || "")
        .toLowerCase();

    const symbolLower = symbol.toLowerCase();

    for(const keyword of NAME_KEYWORD_BLACKLIST){

        if(name.includes(keyword))
            return true;

        if(symbolLower.includes(keyword))
            return true;

    }

    const liquidity =
        Number(pair.liquidity?.usd || 0);

    const p24 =
        Number(pair.priceChange?.h24 || 0);

    if(
        liquidity >= 500000
        &&
        Math.abs(p24) < 1.5
    ){

        return true;

    }

    return false;

}

// =========================================
// TRADE COUNT + BUY/SELL SPLIT FROM
// DEXSCREENER TXNS (real data - buys/sells
// are native DexScreener fields, not derived)
// =========================================

function tradesFromTxns(txns){

    const h1buys = Number(txns?.h1?.buys || 0);
    const h1sells = Number(txns?.h1?.sells || 0);

    const h24buys = Number(txns?.h24?.buys || 0);
    const h24sells = Number(txns?.h24?.sells || 0);

    return{

        h1: h1buys + h1sells,

        h24: h24buys + h24sells,

        h1Buys: h1buys,

        h1Sells: h1sells,

        h24Buys: h24buys,

        h24Sells: h24sells

    };

}

// =========================================
// ACTIVITY SCORE
// (turnover + real trade count > raw size)
// =========================================

function activityScore(pair){

    const liquidity =
        Number(pair.liquidity?.usd || 0);

    const volume =
        Number(pair.volume?.h24 || 0);

    const fdv =
        Number(pair.fdv || 999999999);

    const ratio =
        liquidity>0
        ? volume/liquidity
        :0;

    const trades24h =
        Number(
            pair.trades?.h24 ||
            (
                Number(pair.txns?.h24?.buys||0)+
                Number(pair.txns?.h24?.sells||0)
            ) ||
            0
        );

    return(

        (ratio * 20000)

        +

        (volume * 1.5)

        +

        liquidity

        +

        (trades24h * 300)

        -

        (fdv * 0.02)

    );

}

// =========================================
// UNIQUE DEX PAIRS
// Identity key = contract address ONLY.
// =========================================

function uniquePairs(pairs){

    const map = {};

    pairs.forEach(pair=>{

        const address = pair.baseToken?.address;

        if(!address) return;

        if(!pair.trades){

            pair.trades = tradesFromTxns(pair.txns);

        }

        if(pair.holder===undefined){

            pair.holder = null;

        }

        const score = activityScore(pair);

        if(

            !map[address]

            ||

            score > map[address].__score

        ){

            pair.__score = score;

            map[address] = pair;

        }

    });

    return Object.values(map);

}

// =========================================
// FILTER (discovery quality gate - unchanged,
// only used by trending())
// =========================================

function filterPairs(pairs){

    return pairs.filter(pair=>{

        if(!pair.baseToken)
            return false;

        if(pair.chainId!=="solana")
            return false;

        const symbol =
            (pair.baseToken.symbol || "")
            .toUpperCase();

        if(symbol==="")
            return false;

        if(isNonMemeToken(pair))
            return false;

        const liquidity =
            Number(pair.liquidity?.usd || 0);

        const volume =
            Number(pair.volume?.h24 || 0);

        const fdv =
            Number(pair.fdv || 0);

        const price =
            Number(pair.priceUsd || 0);

        const logo =
            pair.info?.imageUrl || "";

        const trades24h =
            Number(
                pair.trades?.h24 ||
                (
                    Number(pair.txns?.h24?.buys||0)+
                    Number(pair.txns?.h24?.sells||0)
                ) ||
                0
            );

        if(liquidity < 8000)
            return false;

        if(volume < 5000)
            return false;

        if(fdv < 30000)
            return false;

        if(fdv > 50000000)
            return false;

        if(price <= 0)
            return false;

        if(!logo)
            return false;

        if(trades24h > 0 && trades24h < 5)
            return false;

        // Spread proxy: liquidity so small relative to fdv
        // that the pool is basically a shell - not worth
        // scoring at all (distinct from "backingScore" which
        // penalizes weak-but-real backing further up the
        // scale).

        if(fdv>0 && (liquidity/fdv) < 0.005)
            return false;

        return true;

    });

}

// =========================================
// SORT CANDIDATE
// =========================================

function sortPairs(pairs){

    return pairs.sort((a,b)=>{

        return activityScore(b) - activityScore(a);

    });

}

// =========================================
// DEXSCREENER DISCOVERY (sole source now)
// =========================================

function chunkAddresses(list, size){

    const out = [];

    for(let i=0;i<list.length;i+=size){

        out.push(list.slice(i, i+size));

    }

    return out;

}

async function safeFetchJson(url, statusKey){

    try{

        const res = await fetch(url);

        if(!res.ok){

            if(statusKey) API_STATUS[statusKey]="error";

            return null;

        }

        const json = await res.json();

        if(statusKey) API_STATUS[statusKey]="ok";

        return json;

    }

    catch(e){

        // A single source failing (network hiccup, ad-blocker,
        // DNS, temporary DexScreener outage, etc) is expected
        // and already handled gracefully below - it should not
        // read as a red console error for something the app is
        // actively designed to tolerate.

        console.warn("Discovery source fetch failed:", url, e);

        if(statusKey){

            API_STATUS[statusKey]="error";

        }

        API_STATUS.lastError = e.message || String(e);

        return null;

    }

}

// =========================================
// DISCOVERY SOURCES (modular market-observation
// adapters)
//
// Each source is a self-contained adapter with the same
// shape: { name, statusKey, fetchCandidates() }.
// fetchCandidates() resolves to an array of Solana token
// addresses observed from that market feed - never from a
// keyword/text search. Adding a new provider later
// (Birdeye, Helius DAS "new mints", Jupiter's token list, a
// Pump.fun feed) means adding one more object to this array
// - nothing else in the discovery pipeline needs to change.
// =========================================

async function fetchSolanaAddressesFromFeed(url, statusKey){

    const json = await safeFetchJson(url, statusKey);

    const list = Array.isArray(json) ? json : [];

    const addresses = [];

    list.forEach(item=>{

        if(item?.chainId==="solana" && item?.tokenAddress){

            addresses.push(item.tokenAddress);

        }

    });

    return addresses;

}

const DISCOVERY_SOURCES = [

    {

        name: "Boosted (Latest)",

        statusKey: "boostsLatest",

        fetchCandidates: ()=>

            fetchSolanaAddressesFromFeed(DEX_BOOSTS_LATEST_URL, "boostsLatest")

    },

    {

        name: "Boosted (Top)",

        statusKey: "boostsTop",

        fetchCandidates: ()=>

            fetchSolanaAddressesFromFeed(DEX_BOOSTS_TOP_URL, "boostsTop")

    },

    {

        // Fixed from Batch A: this endpoint is "latest NEW
        // profiles", not "recently updated" - the real
        // recent-updates endpoint is its own separate source
        // right below. Renamed for accuracy only, same URL.

        name: "New Token Profiles",

        statusKey: "profilesLatest",

        fetchCandidates: ()=>

            fetchSolanaAddressesFromFeed(DEX_PROFILES_LATEST_URL, "profilesLatest")

    },

    {

        // Real, distinct DexScreener endpoint - existing
        // profiles that were just updated (different market
        // signal than a brand new profile).

        name: "Recently Updated Profiles",

        statusKey: "profilesRecentUpdates",

        fetchCandidates: ()=>

            fetchSolanaAddressesFromFeed(DEX_PROFILES_RECENT_UPDATES_URL, "profilesRecentUpdates")

    },

    {

        name: "Community Takeovers",

        statusKey: "communityTakeovers",

        fetchCandidates: ()=>

            fetchSolanaAddressesFromFeed(DEX_COMMUNITY_TAKEOVERS_URL, "communityTakeovers")

    },

    {

        // Genuinely market-driven, not keyword-driven: the
        // "metas" (narrative categories) come from
        // DexScreener's own trending computation, not from a
        // predefined word list we chose. We just read whatever
        // is trending right now and pull its pairs.

        name: "Trending Metas",

        statusKey: "trendingMetas",

        fetchCandidates: async ()=>{

            const metas = await safeFetchJson(DEX_METAS_TRENDING_URL, "trendingMetas");

            if(!Array.isArray(metas)) return [];

            // Was hardcoded to the top 5 metas - DexScreener
            // currently returns ~19-20 trending metas total, so
            // this was only using a quarter of what's actually
            // available. Use everything the endpoint returns,
            // with a generous safety cap (25) purely to bound
            // worst-case parallel requests if the list ever
            // grows unusually large - not a deliberate limit on
            // coverage.

            const topMetas = metas.slice(0, 25);

            const results = await Promise.all(

                topMetas.map(async meta=>{

                    if(!meta?.slug) return [];

                    try{

                        // Sub-lookups don't carry their own
                        // statusKey - one slow/broken meta
                        // shouldn't flip overall Engine Health,
                        // the top-level trendingMetas fetch
                        // above already covers that signal.

                        const json = await safeFetchJson(metaDetailUrl(meta.slug));

                        const pairs = Array.isArray(json?.pairs) ? json.pairs : [];

                        return pairs

                            .filter(p=>p?.chainId==="solana" && p?.baseToken?.address)

                            .map(p=>p.baseToken.address);

                    }

                    catch(e){

                        console.warn(`Meta "${meta.slug}" lookup failed`, e);

                        return [];

                    }

                })

            );

            return results.flat();

        }

    }

    // Future market-observation sources go here, e.g.:
    // {
    //   name: "Birdeye Trending",
    //   statusKey: "birdeye",
    //   fetchCandidates: async () => { ... }
    // }
    // Each new entry must return Solana addresses only and
    // report through safeFetchJson (or an equivalent that
    // sets API_STATUS[statusKey]) so Engine Health keeps
    // reflecting reality automatically - computeHealth()
    // already iterates DISCOVERY_SOURCES, it never needs to
    // be edited when a source is added.

];

DISCOVERY_SOURCES.forEach(s=>{

    if(API_STATUS[s.statusKey]===undefined){

        API_STATUS[s.statusKey]="unknown";

    }

});

// Metadata about the last discovery cycle - real counts
// only, used by the UI to show what's actually being
// monitored (never a made-up number).

const LAST_DISCOVERY_META = {

    sourceBreakdown: {},

    rawObserved: 0,

    uniqueCandidatesObserved: 0,

    filteredOut: 0,

    qualifiedAfterFilter: 0,

    displayed: 0,

    discoveryDurationMs: null,

    lastRunAt: null

};

async function fetchDiscoveryAddresses(){

    const results = await Promise.all(

        DISCOVERY_SOURCES.map(source=>

            source.fetchCandidates().catch(e=>{

                console.warn(`Discovery source "${source.name}" failed`, e);

                API_STATUS[source.statusKey]="error";

                return [];

            })

        )

    );

    const addresses = new Set();

    const breakdown = {};

    let rawTotal = 0;

    results.forEach((list, i)=>{

        breakdown[DISCOVERY_SOURCES[i].name] = list.length;

        rawTotal += list.length;

        list.forEach(addr=>addresses.add(addr));

    });

    LAST_DISCOVERY_META.rawObserved = rawTotal;

    LAST_DISCOVERY_META.sourceBreakdown = breakdown;

    LAST_DISCOVERY_META.uniqueCandidatesObserved = addresses.size;

    LAST_DISCOVERY_META.lastRunAt = Date.now();

    return addresses;

}

async function fetchPairsByAddresses(addresses){

    const batches =
        chunkAddresses(addresses, DEX_BATCH_SIZE);

    let anyFailed = false;

    let anyOk = false;

    const results =

        await Promise.all(

            batches.map(async batch=>{

                const json =
                    await safeFetchJson(
                        DEX_TOKENS_URL + batch.join(",")
                    );

                if(json===null){

                    anyFailed = true;

                    return [];

                }

                anyOk = true;

                return json?.pairs || [];

            })

        );

    if(anyFailed && !anyOk){

        API_STATUS.dexTokens="error";

    }
    else if(anyFailed){

        API_STATUS.dexTokens="partial";

    }
    else{

        API_STATUS.dexTokens="ok";

    }

    return results.flat();

}

// =========================================
// SEARCH HELPERS (live full-market lookup)
// =========================================

function looksLikeContractAddress(q){

    // Solana mint addresses: base58, ~32-44 chars
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);

}

// Light-touch filter for search results: only
// remove junk that can't be shown at all (no
// symbol / wrong chain). Does NOT apply the
// discovery quality gate (liquidity/fdv/volume
// thresholds) - a user searching for a specific
// coin must get it back, big or small.

function filterSearchResults(pairs){

    return pairs.filter(pair=>{

        if(!pair.baseToken)
            return false;

        if(pair.chainId!=="solana")
            return false;

        const symbol =
            (pair.baseToken.symbol || "").trim();

        if(symbol==="")
            return false;

        return true;

    });

}

// =========================================
// API
// =========================================

const API={

    // =====================================
    // SEARCH (entire market - live API,
    // symbol / name / contract address)
    // =====================================

    async search(query){

        const q = (query || "").trim();

        if(!q) return [];

        try{

            let rawPairs = [];

            if(looksLikeContractAddress(q)){

                const json =
                    await safeFetchJson(
                        DEX_TOKENS_URL + q
                    );

                rawPairs = json?.pairs || [];

            }

            else{

                const json =
                    await safeFetchJson(
                        DEX_SEARCH_URL +
                        encodeURIComponent(q)
                    );

                rawPairs = json?.pairs || [];

            }

            let pairs =
                uniquePairs(rawPairs);

            pairs =
                filterSearchResults(pairs);

            return sortPairs(pairs);

        }

        catch(e){

            console.error(e);

            return [];

        }

    },

    // =====================================
    // TRENDING (DexScreener discovery,
    // cached briefly to avoid duplicate calls)
    // =====================================

    async trending(){

        const now = Date.now();

        if(

            trendingCache.data

            &&

            (now - trendingCache.ts) < TRENDING_CACHE_TTL

        ){

            return trendingCache.data;

        }

        const startedAt = Date.now();

        try{

            const dexAddresses =
                await fetchDiscoveryAddresses();

            const addresses = Array.from(dexAddresses);

            if(!addresses.length)
                return [];

            const rawPairs =
                await fetchPairsByAddresses(addresses);

            let pairs =
                uniquePairs(rawPairs);

            const preFilterCount = pairs.length;

            pairs =
                filterPairs(pairs);

            recordPriceHistory(pairs);

            LAST_DISCOVERY_META.qualifiedAfterFilter = pairs.length;

            LAST_DISCOVERY_META.filteredOut =
                Math.max(0, preFilterCount - pairs.length);

            API_STATUS.lastUpdated = Date.now();

            const result =
                sortPairs(pairs).slice(0,DISCOVERY_LIMIT);

            LAST_DISCOVERY_META.displayed = result.length;

            LAST_DISCOVERY_META.discoveryDurationMs =
                Date.now() - startedAt;

            trendingCache = { data: result, ts: now };

            return result;

        }

        catch(e){

            console.error(e);

            API_STATUS.lastError = e.message || String(e);

            return [];

        }

    },

    // =====================================
    // STATUS (real connectivity, used by
    // dashboard for Engine/Live indicators)
    // =====================================

    getStatus(){

        return{

            ...computeHealth(),

            details:{ ...API_STATUS }

        };

    },

    // =====================================
    // DISCOVERY META (real numbers only - how
    // many addresses were actually observed
    // across all market sources this cycle, and
    // how many passed the quality filter. Used
    // for the "Monitoring / Showing" labels -
    // never a placeholder or a guess.)
    // =====================================

    getDiscoveryMeta(){

        return{

            sourceBreakdown: { ...LAST_DISCOVERY_META.sourceBreakdown },

            rawObserved: LAST_DISCOVERY_META.rawObserved,

            uniqueCandidatesObserved: LAST_DISCOVERY_META.uniqueCandidatesObserved,

            filteredOut: LAST_DISCOVERY_META.filteredOut,

            qualifiedAfterFilter: LAST_DISCOVERY_META.qualifiedAfterFilter,

            displayed: LAST_DISCOVERY_META.displayed,

            discoveryDurationMs: LAST_DISCOVERY_META.discoveryDurationMs,

            lastRunAt: LAST_DISCOVERY_META.lastRunAt

        };

    }

};
