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
// TEMPORARY (P0 GMGN IP ban investigation) - see requestDiagnostics.js
// header. Remove this import + the logging calls below once closed.
const requestDiagnostics = require("./requestDiagnostics");

// ROOT CAUSE FIX (collector-staleness investigation): every request
// below used to have no timeout at all - Node's built-in fetch waits
// indefinitely by default. A single slow/hung GMGN response could stall
// an `await fetch(...)` for minutes, and since
// scheduler/gmgnTrendingScheduler.js runs all 7 collectors SEQUENTIALLY
// inside one tick (never overlapping - see its `isRunning` guard), one
// stuck call anywhere in this file stalled the entire batch, which is
// exactly what produced the multi-minute gaps observed in
// gmgn_tokens.updated_at (verified against real timestamps, not
// inferred). 15s is generous versus this endpoint's normal real-world
// latency (a few hundred ms) while bounding the worst case to a small
// multiple of the scheduler's own 30s tick interval, instead of
// unbounded.
const REQUEST_TIMEOUT_MS = 15000;

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

// Wraps a bare timeout abort into the same GmgnAuthError shape every
// other failure in this file already throws, so
// scheduler/gmgnTrendingScheduler.js's per-collector catch (and the
// health monitoring reading its recorded lastError - see
// getCollectorHealth() there) sees one consistent, readable message
// ("GET /v1/market/rank timed out after 15000ms") instead of a bare
// AbortError with no endpoint context.
async function fetchWithTimeout(url, options, method, subPath){

    // TEMPORARY (P0 GMGN IP ban investigation) - startedAt/finishedAt
    // capture and the requestDiagnostics.logRequest() calls below are
    // diagnostic-only additions. Every return/throw path below is
    // byte-for-byte identical to before this instrumentation - no
    // behavior, retry, or throttling change.
    const startedAt = Date.now();

    try{

        const res = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

        requestDiagnostics.logRequest({ method, subPath, startedAt, finishedAt: Date.now(), status: res.status, url });

        return res;

    }
    catch(err){

        if(err.name === "TimeoutError" || err.name === "AbortError"){

            requestDiagnostics.logRequest({ method, subPath, startedAt, finishedAt: Date.now(), status: "TIMEOUT", url });

            throw new GmgnAuthError(`${method} ${subPath} timed out after ${REQUEST_TIMEOUT_MS}ms`, {});

        }

        requestDiagnostics.logRequest({ method, subPath, startedAt, finishedAt: Date.now(), status: `ERROR:${err.name}`, url });

        throw err;

    }

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

function createGmgnClient({ apiKey, privateKeyPem, host, coalesceRequests = false, coalesceTtlMs = REQUEST_TIMEOUT_MS + 10000 }){

    if(!apiKey){

        throw new Error("GMGN_API_KEY is required to create a GMGN client");

    }

    const baseHost = host.replace(/\/$/, "");

    // Request coalescing (Held-Position Refresh Architecture, Design 2):
    // when two callers ask for the exact same logical request (method +
    // subPath + queryExtra + body) while one is already in flight on
    // THIS client instance, the second caller shares the first's Promise
    // instead of issuing a second HTTP call. Keyed BEFORE buildAuthQuery()
    // runs (see signer.js - timestamp/client_id are fresh, random per
    // call) so two truly-identical requests coalesce regardless of the
    // auth nonce each would otherwise get - keying on the final signed
    // URL would never match. Purely an in-flight dedup, not a cache: the
    // entry is removed as soon as the shared promise settles (success or
    // failure) in the `finally` below, so the very next call always goes
    // live again. Scoped to this client instance only.
    //
    // OFF by default (coalesceRequests: false) - deliberately opt-in.
    // services/marketDataGateway.js's single shared instance is the only
    // caller that turns it on, for read-only market-data GETs. A trade
    // submission (POST /v1/trade/swap, services/execution/index.js's own
    // separate client instance) must never be silently merged with
    // another in-flight one - two positions could legitimately submit
    // byte-identical swap params moments apart, and each must produce
    // its own real, independent trade. Never touching that instance's
    // behavior is the whole reason this is a constructor flag, not a
    // hardcoded default.
    const inFlightRequests = coalesceRequests ? new Map() : null;

    function buildCoalesceKey(method, subPath, queryExtra, body){
        return `${method} ${subPath} ${JSON.stringify(queryExtra)} ${body !== null ? JSON.stringify(body) : ""}`;
    }

    // ROOT-CAUSE FIX (gmgn-scheduler chronic-hang investigation,
    // 2026-08-07): fetchWithTimeout's AbortSignal.timeout only bounds
    // fetch() itself - it does NOT cover parseResponse()'s later
    // `await res.text()`, which runs after fetch() has already resolved
    // with a 200 and headers. If GMGN ever returns headers but then
    // stalls mid-body (proxy hiccup, half-open connection), that read
    // hangs with no timeout at all, and `run()` above never settles.
    // Every one of gmgnTrendingScheduler.js's 6 coalesced collectors
    // calls THIS gateway with byte-identical params every single 30s
    // tick, so the coalesce key never changes tick to tick - once one
    // call hangs, every later tick for that same collector just joins
    // the same dead promise forever, silently, with no new HTTP request
    // ever attempted again. That matches the observed incident exactly:
    // gmgn_tokens stops updating and only a full pm2 restart (which
    // wipes this in-memory map) recovers it - the scheduler's own
    // 5-minute lock-guard watchdog does NOT help, since it only
    // force-releases the NEXT tick's ability to acquire the lock, while
    // the still-pinned dead promise keeps blocking every tick that
    // reaches this same coalesce key.
    //
    // Fix: an entry older than coalesceTtlMs is no longer trusted by
    // future callers. There's no reliable way to cancel an already-hung
    // res.text() call, so a stale entry isn't cancelled - it's simply
    // abandoned, and the next caller for that key gets a fresh,
    // independent request instead of joining the dead one. If the old
    // promise does eventually settle later, its own cleanup only
    // deletes the map entry if it's still the current one for that key
    // (guards against deleting a newer entry that has since replaced it
    // - see the `finally` below).
    async function coalesce(method, subPath, queryExtra, body, run){

        if(!inFlightRequests) return run();

        const key = buildCoalesceKey(method, subPath, queryExtra, body);
        const existing = inFlightRequests.get(key);

        if(existing){

            const age = Date.now() - existing.startedAt;

            if(age < coalesceTtlMs) return existing.promise;

            // TEMPORARY diagnostic (remove once the underlying hang is
            // confirmed/fixed at its true source) - confirms live
            // whether this is really what fires during a stall.
            console.warn(`[gmgn-coalesce] STALE in-flight entry for key="${key}" age=${age}ms exceeds ${coalesceTtlMs}ms ceiling - abandoning it and issuing a fresh request instead of joining a possibly-dead promise`);

        }

        const entry = { startedAt: Date.now(), promise: null };
        entry.promise = run();
        inFlightRequests.set(key, entry);

        try{
            return await entry.promise;
        }
        finally{
            if(inFlightRequests.get(key) === entry){
                inFlightRequests.delete(key);
            }
        }

    }

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

        return coalesce(method, subPath, queryExtra, body, async () => {

            const { timestamp, client_id } = buildAuthQuery();

            const query = { ...queryExtra, timestamp, client_id };

            const url = buildUrl(`${baseHost}${subPath}`, query);

            const headers = {

                "X-APIKEY": apiKey,

                "Content-Type": "application/json",

                "User-Agent": "crabsem-server/0.1.0"

            };

            const bodyStr = body !== null ? JSON.stringify(body) : undefined;

            const res = await fetchWithTimeout(url, { method, headers, body: bodyStr }, method, subPath);

            return parseResponse(method, subPath, res);

        });

    }

    async function authSignedRequest(method, subPath, queryExtra = {}, body = null){

        if(!privateKeyPem){

            throw new Error("GMGN_PRIVATE_KEY is required for signed GMGN requests");

        }

        return coalesce(method, subPath, queryExtra, body, async () => {

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

            const res = await fetchWithTimeout(url, { method, headers, body: bodyStr || undefined }, method, subPath);

            return parseResponse(method, subPath, res);

        });

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

    // GET /v1/trade/quote - real-time swap quote (price, route, fee,
    // blockhash/expiry scaffold). API-key-only auth ("exist") - verified
    // live against the real endpoint (Sprint 2 planning). Params are
    // exactly what the live API required by trial, not guessed: chain,
    // input_token, output_token, from_address, input_amount, slippage.

    async function getSwapQuote(chain, { inputToken, outputToken, fromAddress, inputAmount, slippage }){

        return authExistRequest("GET", "/v1/trade/quote", {

            chain,

            input_token: inputToken,

            output_token: outputToken,

            from_address: fromAddress,

            input_amount: inputAmount,

            slippage

        });

    }

    // POST /v1/trade/swap - executes a real swap. Signed auth (requires
    // GMGN_PRIVATE_KEY). Params match GMGN's own official reference
    // client's SwapParams type exactly (read verbatim from
    // github.com/GMGNAI/gmgn-skills/blob/main/src/client/OpenApiClient.ts
    // during the Sprint 2 investigation, not guessed) - `chain` and
    // `from_address` plus whatever of the optional fields the caller
    // supplies are sent as the POST body.
    //
    // CONFIRMED from that same source (the entire swap() method there is
    // a one-line authSignedRequest call, no local transaction handling
    // anywhere in the file): GMGN signs and broadcasts server-side. This
    // function only ever sends parameters - it never builds, signs, or
    // holds a Solana transaction object. See gmgnSwapTransactionBuilder.js
    // for how the response (order_id/hash/status) is used.

    async function submitSwap(chain, { fromAddress, inputToken, outputToken, inputAmount, slippage, ...extra }){

        return authSignedRequest("POST", "/v1/trade/swap", {}, {

            chain,

            from_address: fromAddress,

            input_token: inputToken,

            output_token: outputToken,

            input_amount: inputAmount,

            slippage,

            ...extra

        });

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

        getSwapQuote,

        submitSwap,

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
