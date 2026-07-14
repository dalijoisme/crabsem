const CONFIG = {

    // APP
    APP_NAME: "CRAB AGENT",

    VERSION: "1.3.0",

    // Auto-refresh interval for the discovery pipeline
    // (DexScreener only - Birdeye Worker was removed after
    // its compute units were exhausted). DexScreener's free
    // public endpoints are far less restrictive, but 60s is
    // kept anyway to minimize requests and stay well clear
    // of any rate limit. The on-screen countdown still ticks
    // every 1s (UI-only, no network cost) independently of
    // this value.
    SCAN_INTERVAL: 60000,

    MIN_CRABSEM_HOLDING: 100000,

    // CRABSEM
    CRAB_MINT: "EJRL33sEvmyY9HJgCom2uYHqBtRduBuRnqZpzhuapump",

    // HELIUS
    HELIUS_RPC: "https://mainnet.helius-rpc.com/?api-key=5bb1ade7-09d8-450c-9976-771ebf5e4522",

    // GMGN referral - used to build the "Trade on GMGN"
    // link dynamically per token. Never hardcode this in
    // ui.js.
    GMGN_REFERRAL_CODE: "hKoEhzSD",

    // ANALYTICS
    // No backend endpoint exists yet. Events are counted
    // locally (sessionStorage) only - nothing is sent
    // anywhere. This is intentionally honest: flip
    // ANALYTICS_ENDPOINT to a real URL later to actually
    // transmit events; until then, treat all analytics as
    // local-only instrumentation.
    ANALYTICS_ENDPOINT: null

};
