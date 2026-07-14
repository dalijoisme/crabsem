// =========================================
// CRAB AGENT API V5.1
// DexScreener ONLY (free, no API key, no paid tier)
//
// V5.1: discovery pool widened (looser admission filter,
// DISCOVERY_LIMIT 40->100) - quality control now leans on
// Engine's score/sort instead of a strict pre-filter, per
// "discover more, let scoring decide". Also added a real
// in-memory price/liquidity history sampled every scan
// cycle, so Engine can see actual session trend instead of
// only a single snapshot.
//
// Birdeye Worker has been removed entirely - its
// compute units are exhausted and every call returned
// HTTP 500. DexScreener's public endpoints already
// covered every field we used Birdeye for (liquidity,
// volume, fdv, marketCap, priceChange, txns), so nothing
// numeric is "faked" here - it's the same data shape,
// just from one real free source instead of two.
//
// DexScreener already indexes Pump.fun / PumpSwap pairs
// once they have any pool (dexId shows "pumpfun" /
// "pumpswap"), so we get that coverage without a separate,
// unverified Pump.fun API integration.
//
// The one thing genuinely lost: Birdeye was our only
// source for raw holder COUNT. `pair.holder` will now
// always be null - Engine already treats that as neutral
// (see engine.js), and the UI already renders "-" for it,
// so nothing breaks or shows a fake number.
// =========================================

const DEX_BOOSTS_LATEST_URL =
    "https://api.dexscreener.com/token-boosts/latest/v1";

const DEX_BOOSTS_TOP_URL =
    "https://api.dexscreener.com/token-boosts/top/v1";

const DEX_PROFILES_LATEST_URL =
    "https://api.dexscreener.com/token-profiles/latest/v1";

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

    boostsLatest:"unknown",
    boostsTop:"unknown",
    profiles:"unknown",
    dexTokens:"unknown",

    lastError:null,
    lastUpdated:null

};

function computeHealth(){

    const discoverySignals = [

        API_STATUS.boostsLatest,

        API_STATUS.boostsTop,

        API_STATUS.profiles

    ];

    const anyDiscoveryOk =
        discoverySignals.some(s=>s==="ok");

    const allDiscoveryFail =
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

        if(liquidity < 12000)
            return false;

        if(volume < 7000)
            return false;

        if(fdv < 50000)
            return false;

        if(fdv > 50000000)
            return false;

        if(price <= 0)
            return false;

        if(!logo)
            return false;

        if(trades24h > 0 && trades24h < 8)
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

        console.error(e);

        if(statusKey){

            API_STATUS[statusKey]="error";

        }

        API_STATUS.lastError = e.message || String(e);

        return null;

    }

}

async function fetchDiscoveryAddresses(){

    const addresses = new Set();

    const sourceConfigs = [

        { url:DEX_BOOSTS_LATEST_URL, key:"boostsLatest" },

        { url:DEX_BOOSTS_TOP_URL, key:"boostsTop" },

        { url:DEX_PROFILES_LATEST_URL, key:"profiles" }

    ];

    const results =
        await Promise.all(
            sourceConfigs.map(s=>safeFetchJson(s.url, s.key))
        );

    results.forEach(json=>{

        const list =
            Array.isArray(json)
            ? json
            : [];

        list.forEach(item=>{

            if(
                item?.chainId==="solana"
                &&
                item?.tokenAddress
            ){

                addresses.add(item.tokenAddress);

            }

        });

    });

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

            pairs =
                filterPairs(pairs);

            recordPriceHistory(pairs);

            API_STATUS.lastUpdated = Date.now();

            const result =
                sortPairs(pairs).slice(0,DISCOVERY_LIMIT);

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

    }

};
