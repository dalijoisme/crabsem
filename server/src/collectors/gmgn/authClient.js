// collectors/gmgn/authClient.js - minimal GMGN OpenAPI client.
//
// Implements the two official auth modes ("exist" = API key only,
// "signed" = API key + Ed25519/RSA signature) and exposes only the
// domain methods this project actually uses. No swap/order/trading
// methods exist here - this project never signs or submits
// transactions, per the "no trading logic" constraint.
//
// Ported from GMGN's own official reference client:
// https://github.com/GMGNAI/gmgn-skills/blob/main/src/client/OpenApiClient.ts

const { buildAuthQuery, buildMessage, detectAlgorithm, sign } = require("./signer");

function buildUrl(base, query){

    const params = new URLSearchParams();

    for(const [k, v] of Object.entries(query)){

        if(Array.isArray(v)){

            v.forEach(item => params.append(k, item));

        }
        else{

            params.set(k, String(v));

        }

    }

    return `${base}?${params.toString()}`;

}

class GmgnAuthError extends Error {

    constructor(message, { status, apiCode, apiError } = {}){

        super(message);

        this.name = "GmgnAuthError";
        this.status = status;
        this.apiCode = apiCode;
        this.apiError = apiError;

    }

}

function createGmgnClient({ apiKey, privateKeyPem, host }){

    if(!apiKey){

        throw new Error("GMGN_API_KEY is required to create a GMGN client");

    }

    const baseHost = host.replace(/\/$/, "");

    async function parseResponse(method, subPath, res){

        const text = await res.text();

        let json;

        try{

            json = JSON.parse(text);

        }
        catch(e){

            throw new GmgnAuthError(
                `${method} ${subPath} failed: HTTP ${res.status} (non-JSON response): ${text.slice(0, 300)}`,
                { status: res.status }
            );

        }

        if(json.code !== 0){

            throw new GmgnAuthError(
                `${method} ${subPath} failed: HTTP ${res.status} code=${json.code} error=${json.error || ""} message=${json.message || ""}`,
                { status: res.status, apiCode: json.code, apiError: json.error }
            );

        }

        // `raw` is the exact, unmodified response body text GMGN sent -
        // this is what gets persisted verbatim by the collector.

        return { data: json.data, raw: text };

    }

    async function authExistRequest(method, subPath, queryExtra = {}, body = null){

        const { timestamp, client_id } = buildAuthQuery();

        const query = { ...queryExtra, timestamp, client_id };

        const url = buildUrl(`${baseHost}${subPath}`, query);

        const headers = {

            "X-APIKEY": apiKey,

            "Content-Type": "application/json",

            "User-Agent": "crabsem-server/0.1.0"

        };

        const bodyStr = body !== null ? JSON.stringify(body) : undefined;

        const res = await fetch(url, { method, headers, body: bodyStr });

        return parseResponse(method, subPath, res);

    }

    async function authSignedRequest(method, subPath, queryExtra = {}, body = null){

        if(!privateKeyPem){

            throw new Error("GMGN_PRIVATE_KEY is required for signed GMGN requests");

        }

        const { timestamp, client_id } = buildAuthQuery();

        const query = { ...queryExtra, timestamp, client_id };

        const bodyStr = body !== null ? JSON.stringify(body) : "";

        const message = buildMessage(subPath, query, bodyStr, timestamp);

        const signature = sign(message, privateKeyPem, detectAlgorithm(privateKeyPem));

        const url = buildUrl(`${baseHost}${subPath}`, query);

        const headers = {

            "X-APIKEY": apiKey,

            "X-Signature": signature,

            "Content-Type": "application/json",

            "User-Agent": "crabsem-server/0.1.0"

        };

        const res = await fetch(url, { method, headers, body: bodyStr || undefined });

        return parseResponse(method, subPath, res);

    }

    // ---- Market / Trending ----
    // GET /v1/market/rank - Solana trending tokens by swap activity.
    // "Exist" auth only - no private key needed for this endpoint.

    async function getTrendingSwaps(chain, interval, extra = {}){

        return authExistRequest("GET", "/v1/market/rank", { chain, interval, ...extra });

    }

    // POST /v1/trenches - new_creation/near_completion/completed token
    // launches. Body shape ported exactly from GMGN's own reference
    // client (buildTrenchesBody in gmgn-cli's market.ts) - omitting
    // launchpad_platform/quote_address_type caused a response section
    // to come back mislabeled in live testing, so this is not a
    // simplified/guessed shape.

    async function getTrenches(chain, body){

        return authExistRequest("POST", "/v1/trenches", { chain }, body);

    }

    // POST /v1/market/hot_searches - most-searched tokens per chain/interval.

    async function getHotSearches(params){

        return authExistRequest("POST", "/v1/market/hot_searches", {}, { params });

    }

    // GET /v1/user/kol - NOT a KOL directory: a live feed of recent
    // transactions made by KOL-tagged wallets (verified in live
    // testing, not assumed from the method name).

    async function getKolActivity(chain, limit){

        const query = {};

        if(chain) query.chain = chain;

        if(limit != null) query.limit = limit;

        return authExistRequest("GET", "/v1/user/kol", query);

    }

    // GET /v1/user/smartmoney - same shape as getKolActivity: a live
    // feed of transactions made by smart-money-tagged wallets.

    async function getSmartMoneyActivity(chain, limit){

        const query = {};

        if(chain) query.chain = chain;

        if(limit != null) query.limit = limit;

        return authExistRequest("GET", "/v1/user/smartmoney", query);

    }

    // GET /v1/trade/gas_price - current network fee snapshot.

    async function getGasPrice(chain){

        return authExistRequest("GET", "/v1/trade/gas_price", { chain });

    }

    // GET /v1/cooking/statistics - token-creation counts per launchpad
    // platform. No parameters (verified against the real endpoint).

    async function getCookingStatistics(){

        return authExistRequest("GET", "/v1/cooking/statistics", {});

    }

    // ---- Token endpoints (on-demand, per-token) ----

    async function getTokenSecurity(chain, address){

        return authExistRequest("GET", "/v1/token/security", { chain, address });

    }

    async function getTokenPoolInfo(chain, address){

        return authExistRequest("GET", "/v1/token/pool_info", { chain, address });

    }

    async function getTokenTopHolders(chain, address, extra = {}){

        return authExistRequest("GET", "/v1/market/token_top_holders", { chain, address, ...extra });

    }

    async function getTokenTopTraders(chain, address, extra = {}){

        return authExistRequest("GET", "/v1/market/token_top_traders", { chain, address, ...extra });

    }

    async function getTokenKline(chain, address, resolution, from, to){

        const query = { chain, address, resolution };

        if(from != null) query.from = from;

        if(to != null) query.to = to;

        return authExistRequest("GET", "/v1/market/token_kline", query);

    }

    // ---- Wallet endpoints (on-demand, per-wallet) ----

    async function getWalletActivity(chain, walletAddress, extra = {}){

        return authExistRequest("GET", "/v1/user/wallet_activity", { chain, wallet_address: walletAddress, ...extra });

    }

    async function getWalletStats(chain, walletAddresses, period = "7d"){

        return authExistRequest("GET", "/v1/user/wallet_stats", { chain, wallet_address: walletAddresses, period });

    }

    async function getWalletTokenBalance(chain, walletAddress, tokenAddress){

        return authExistRequest("GET", "/v1/user/wallet_token_balance", { chain, wallet_address: walletAddress, token_address: tokenAddress });

    }

    async function getCreatedTokens(chain, walletAddress, extra = {}){

        return authExistRequest("GET", "/v1/user/created_tokens", { chain, wallet_address: walletAddress, ...extra });

    }

    // SIGNED auth - requires GMGN_PRIVATE_KEY. Read-only (portfolio
    // lookup), not a trade - still uses the signed path because
    // that's what GMGN's own API requires for this endpoint.

    async function getWalletHoldings(chain, walletAddress, extra = {}){

        return authSignedRequest("GET", "/v1/user/wallet_holdings", { chain, wallet_address: walletAddress, ...extra }, null);

    }

    // ---- Zero-param endpoint used purely to verify auth ----

    async function getUserInfo(){

        return authExistRequest("GET", "/v1/user/info", {});

    }

    return {

        authExistRequest,

        authSignedRequest,

        getTrendingSwaps,

        getTrenches,

        getHotSearches,

        getKolActivity,

        getSmartMoneyActivity,

        getGasPrice,

        getCookingStatistics,

        getTokenSecurity,

        getTokenPoolInfo,

        getTokenTopHolders,

        getTokenTopTraders,

        getTokenKline,

        getWalletActivity,

        getWalletStats,

        getWalletTokenBalance,

        getCreatedTokens,

        getWalletHoldings,

        getUserInfo

    };

}

module.exports = { createGmgnClient, GmgnAuthError };
