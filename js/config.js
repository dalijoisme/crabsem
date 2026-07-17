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

    // Holder verification requires holding ANY positive amount
    // of CRABSEM - there is intentionally no minimum. This used
    // to be gated behind a 100,000-token minimum
    // (MIN_CRABSEM_HOLDING); that requirement was removed per
    // explicit product decision. The actual gate now lives in
    // wallet.js as a plain `amount > 0` check, so this constant
    // is no longer read anywhere - left out entirely rather than
    // kept around as a misleading dead value.

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
    ANALYTICS_ENDPOINT: null,

    // ADMIN
    // Temporary client-side password gate for admin.html, as
    // explicitly requested ("nanti akan saya pindahkan ke
    // backend"). Nothing sensitive is actually protected by
    // this - only aggregate, already-public market analytics.
    // Replace this with a real server-side check before this
    // is treated as an actual access control.
    ADMIN_PASSWORD: "crabadmin2026",

    // BACKEND API (dashboard.html only)
    // Our own Node/SQLite backend (see /server) - GMGN data
    // flows GMGN -> Collector -> SQLite -> this REST API ->
    // dashboard.js/backendApi.js. dashboard.html no longer
    // calls DexScreener directly (js/api.js + js/discovery.js
    // stay loaded on index.html/admin.html only, unrelated to
    // this). Local dev default - point this at a real deployed
    // URL before shipping.
    BACKEND_API_URL: "https://api.crabsem.online/api/v1",

    // How often the dashboard polls the backend for fresh
    // trending data. Matches the backend collector's own 30s
    // scheduler interval (server/src/scheduler/gmgnTrendingScheduler.js)
    // - polling faster would just re-fetch the same SQLite rows.
    BACKEND_REFRESH_INTERVAL: 30000

};
