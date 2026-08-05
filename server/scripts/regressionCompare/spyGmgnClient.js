// scripts/regressionCompare/spyGmgnClient.js - Regression Comparator.
//
// A GMGN client with the exact same method surface as
// collectors/gmgn/authClient.js's createGmgnClient() return value -
// stable across both the baseline (a0a8759) and HEAD codebases (grep-
// confirmed during the RATE_LIMIT_BANNED investigation: every existing
// method signature is unchanged between the two, only the internal
// wiring/indirection around them changed). This is what lets ONE spy
// implementation stand in for the real network boundary in EITHER
// version's pipeline.
//
// Every call is recorded with real Date.now() before/after a small,
// deterministic simulated latency (never a real network call - this
// tool must never generate real GMGN traffic, contributing to the exact
// rate-limit problem under investigation) - so timing/ordering/overlap
// in the recorded telemetry reflects the CALLING code's real behavior
// (how many calls, how close together, sequential vs concurrent), not
// GMGN's actual response time. candidate/token identity is extracted
// from each call's real arguments using the same field names GMGN's own
// API actually uses (chain, address, input_token, output_token,
// wallet_address) - never guessed.
//
// origin is set via setOrigin()/getOrigin() below - a minimal stand-in
// for collectors/gmgn/gmgnTrafficAccounting.js's AsyncLocalStorage
// mechanism, which only exists at HEAD. The harness scripts
// (runHead.js/runBaseline.js) call setOrigin() before each conceptual
// phase (held-position refresh, BUY quote, etc.) so both versions get
// the SAME origin-tagging discipline, from the harness itself rather
// than from whichever version's own (possibly nonexistent) instrumentation.

let currentOrigin = "unattributed";

function setOrigin(label){
    currentOrigin = label;
}

function getOrigin(){
    return currentOrigin;
}

function extractCandidateInfo(args){

    // Every wrapped method below passes its own real args here - shapes
    // taken directly from authClient.js's own real method signatures,
    // never guessed.
    const info = {};

    for(const arg of args){

        if(typeof arg === "string" && arg.length >= 20 && arg.length <= 60){
            // A bare string arg this length, in these call shapes, is
            // always a real chain-address (getTokenPoolInfo(chain,address),
            // getTokenKline(chain,address,resolution)) - `chain` itself is
            // always "sol" (3 chars), never mistaken for this.
            info.address = arg;
        }

        if(arg && typeof arg === "object"){
            if(arg.address) info.address = arg.address;
            if(arg.inputToken) info.input_token = arg.inputToken;
            if(arg.outputToken) info.output_token = arg.outputToken;
            if(arg.fromAddress) info.from_address = arg.fromAddress;
            if(arg.walletAddress) info.wallet_address = arg.walletAddress;
        }

    }

    return Object.keys(info).length ? info : null;

}

function createSpyGmgnClient({ telemetry, engineVersion, latencyMsFn = () => 5 + Math.round(Math.random() * 15) }){

    function wrap(methodName, endpoint, fakeResponse){

        return async (...args) => {

            const request_start = Date.now();
            const origin = getOrigin();
            const candidate = extractCandidateInfo(args);

            await new Promise(resolve => setTimeout(resolve, latencyMsFn()));

            const request_finish = Date.now();

            telemetry.push({

                timestamp_ms: request_finish,
                engine_version: engineVersion,
                call_chain: `${origin} -> spyGmgnClient.${methodName}`,
                endpoint,
                origin,
                candidate,
                request_start,
                request_finish,
                duration_ms: request_finish - request_start,
                status: 200

            });

            return typeof fakeResponse === "function" ? fakeResponse(...args) : fakeResponse;

        };

    }

    return {

        getTrendingSwaps: wrap("getTrendingSwaps", "GET /v1/market/rank", { data: { data: { rank: [] } } }),
        getTrenches: wrap("getTrenches", "POST /v1/trenches", { data: {} }),
        getHotSearches: wrap("getHotSearches", "POST /v1/market/hot_searches", { data: {} }),
        getKolActivity: wrap("getKolActivity", "GET /v1/user/kol", { data: [] }),
        getSmartMoneyActivity: wrap("getSmartMoneyActivity", "GET /v1/user/smartmoney", { data: [] }),
        getGasPrice: wrap("getGasPrice", "GET /v1/trade/gas_price", { data: {} }),
        getCookingStatistics: wrap("getCookingStatistics", "GET /v1/cooking/statistics", { data: {} }),

        getTokenSecurity: wrap("getTokenSecurity", "GET /v1/token/security", { data: {} }),
        getTokenPoolInfo: wrap("getTokenPoolInfo", "GET /v1/token/pool_info", { data: { liquidity: "12345.67" } }),
        getTokenTopHolders: wrap("getTokenTopHolders", "GET /v1/market/token_top_holders", { data: [] }),
        getTokenTopTraders: wrap("getTokenTopTraders", "GET /v1/market/token_top_traders", { data: [] }),
        getTokenKline: wrap("getTokenKline", "GET /v1/market/token_kline", { data: { list: [{ close: "1.05" }] } }),

        getWalletActivity: wrap("getWalletActivity", "GET /v1/user/wallet_activity", { data: [] }),
        getWalletStats: wrap("getWalletStats", "GET /v1/user/wallet_stats", { data: {} }),
        getWalletTokenBalance: wrap("getWalletTokenBalance", "GET /v1/user/wallet_token_balance", { data: {} }),
        getCreatedTokens: wrap("getCreatedTokens", "GET /v1/user/created_tokens", { data: [] }),
        getWalletHoldings: wrap("getWalletHoldings", "GET /v1/user/wallet_holdings", { data: [] }),
        getUserInfo: wrap("getUserInfo", "GET /v1/user/info", { data: {} }),

        // A real, plausible quote shape - executionGuard.js's
        // assertQuoteIsSafeToExecute (both versions) reads
        // tx.quote.priceImpactPct and tx.quote.routePlan specifically
        // (confirmed from that file's own real field access), and
        // usdToSolConverter.js reads tx.amount_in_usd - all three must be
        // present and pass the default limits for build() to succeed
        // cleanly, exactly as a real accepted quote would.
        getSwapQuote: wrap("getSwapQuote", "GET /v1/trade/quote", () => ({
            data: {
                amount_in_usd: "150.00",
                output_amount: "1000000000",
                min_output_amount: "990000000",
                tx: {
                    amount_in_usd: "150.00",
                    quote: { priceImpactPct: 0.4, routePlan: [{ hop: 1 }] }
                }
            }
        })),

        // NEVER actually reached by the harness - openPosition's dry-run
        // execution wrapper (see runHead.js/runBaseline.js) returns a
        // synthetic SUCCESS immediately after build()'s own quote step,
        // before ever calling submit(). Present only so a version whose
        // build() shape unexpectedly calls it directly does not crash
        // silently into `undefined is not a function` - it would show up
        // as a very visible, very wrong telemetry row instead.
        submitSwap: wrap("submitSwap", "POST /v1/trade/swap", { data: { hash: "SPY_SHOULD_NEVER_REACH_HERE" } })

    };

}

module.exports = { createSpyGmgnClient, setOrigin, getOrigin };
