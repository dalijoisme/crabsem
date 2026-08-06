require("dotenv").config();

const config = Object.freeze({

    PORT: Number(process.env.PORT) || 4000,

    DB_PATH: process.env.DB_PATH || "./data/crabsem.sqlite",

    NODE_ENV: process.env.NODE_ENV || "development",

    // Comma-separated list of allowed browser origins for CORS, e.g.
    // "https://crabsem.com,https://www.crabsem.com". Empty in
    // development (falls back to permissive CORS - see app.js) so
    // local dev keeps working with no setup; required to be set for
    // a production deployment (see the production-readiness audit).
    CORS_ALLOWED_ORIGINS: (process.env.CORS_ALLOWED_ORIGINS || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean),

    // GMGN OpenAPI - GMGN_PRIVATE_KEY is stored with escaped \n (see
    // collectors/gmgn/generateKeys.js), restored to real newlines here.

    GMGN_API_KEY: process.env.GMGN_API_KEY || null,

    GMGN_PRIVATE_KEY: process.env.GMGN_PRIVATE_KEY
        ? process.env.GMGN_PRIVATE_KEY.replace(/\\n/g, "\n")
        : null,

    GMGN_HOST: process.env.GMGN_HOST || "https://openapi.gmgn.ai",

    // RATE_LIMIT_BANNED investigation, isolation test: feature flag
    // originally built for held-position refresh SCOPE A/B comparison
    // (scripts/regressionCompare/) between "ALL_POSITIONS" (every open
    // position refreshed every exit cycle - the Stop Loss reliability
    // fix from FINAL PRODUCTION SPRINT P0) and "PROFIT_ONLY" (Arjuna
    // a0a8759's own original scope - only profit-protection-territory
    // positions refreshed).
    //
    // STALE, ORPHANED as of the investigation's own conclusion
    // (production trading-quality audit, 2026-08-06 found this while
    // fixing an unrelated test): once PROFIT_ONLY was bisect-confirmed
    // as the real root-cause fix, services/tradingBotEngine.js's
    // manageOpenPositions() was hardcoded byte-for-byte to that scope
    // (see its own header comment - "intentionally NOT restored") rather
    // than left branching on this flag. This env var, and
    // scripts/regressionCompare/'s flag-compare mode, currently have NO
    // effect on real behavior - manageOpenPositions() never reads
    // config.HELD_POSITION_REFRESH_MODE at all. Real production behavior
    // is unconditionally PROFIT_ONLY regardless of this value. Left
    // unwired deliberately here (re-wiring it risks reintroducing the
    // real GMGN rate-limit incident this revert fixed) - flagged for the
    // user's own call on whether to remove this dead flag/tooling or
    // formally re-wire it.
    HELD_POSITION_REFRESH_MODE: (process.env.HELD_POSITION_REFRESH_MODE || "ALL_POSITIONS").trim().toUpperCase(),

    // Admin Panel (engine-quality sprint) - a single shared password,
    // no role system yet (explicitly out of scope for this sprint).
    // null (unset) means the admin API is fully disabled rather than
    // silently open - see middleware/adminAuth.js.
    //
    // Admin-auth bug fix: trimmed here, once, at the single canonical
    // read point - a trailing newline/space in server/.env's
    // ADMIN_PASSWORD line (invisible in an editor, common from a
    // pasted/edited .env file) previously made every comparison in
    // middleware/adminAuth.js and services/adminAuthService.js fail
    // even when the "real" password looked identical. An all-whitespace
    // value trims to "" and falls through to null - never treated as a
    // real, non-empty password.
    ADMIN_PASSWORD: (process.env.ADMIN_PASSWORD || "").trim() || null,

    // Auth + Onboarding sprint - where the frontend is actually served
    // from, used only to build verification/password-reset links (see
    // services/emailService.js). null (unset) is a real, honest state:
    // no real email provider exists yet either (dev-mode stub), so
    // emailService logs a relative path + token instead of guessing a
    // wrong origin.
    FRONTEND_URL: process.env.FRONTEND_URL || null,

    // CRAB User Journey v1 - encrypts the Trading Wallet's private key
    // at rest (AES-256-GCM, see services/walletService.js) and signs
    // the short-lived Owner Wallet ownership challenge (HMAC, same
    // file). Explicitly PLACEHOLDER-GRADE custody: a single server-side
    // secret, not HSM/KMS-backed - real custody architecture is a named
    // deliverable of the next sprint (Trading Wallet & Execution
    // Layer), not this one. Falls back to a fixed, clearly-fake dev
    // value so local development never silently no-ops - a production
    // deployment MUST set a real one (see server startup warning
    // pattern already used for ADMIN_PASSWORD/CORS_ALLOWED_ORIGINS).
    TRADING_WALLET_ENCRYPTION_KEY: process.env.TRADING_WALLET_ENCRYPTION_KEY || "dev-only-insecure-key-do-not-use-in-production",

    // Execution Layer foundation (Sprint 1) - the RPC endpoint every
    // services/execution/*.js module reads/writes the chain through
    // (see services/execution/solanaConnectionProvider.js, the only
    // place that actually constructs a Connection). null - not a
    // public-cluster fallback - means the execution layer is disabled/
    // fails closed, same convention as ADMIN_PASSWORD/GMGN_API_KEY: a
    // real, non-rate-limited RPC endpoint must be deliberately
    // configured before any execution-layer code can run at all.
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || null,

    // Confirmation commitment level every read (balance, signature
    // status) is evaluated against - "confirmed" is the standard
    // middle ground between "processed" (fast, can still be dropped)
    // and "finalized" (slow, unrollbackable).
    SOLANA_COMMITMENT: process.env.SOLANA_COMMITMENT || "confirmed",

    // Trust/UX sprint - which cluster utils/explorerUrl.js links a real
    // tx_hash to. Purely a link-building label, never passed to
    // solanaConnectionProvider.js/SOLANA_RPC_URL - changing this does
    // not change which network transactions actually execute against.
    SOLANA_CLUSTER: process.env.SOLANA_CLUSTER || "mainnet-beta",

    // How long transactionConfirmationService.js polls before giving
    // up and reporting TIMEOUT (not FAILED - see executorStateMachine.js's
    // header comment for why those are deliberately different outcomes).
    EXECUTION_CONFIRMATION_TIMEOUT_MS: Number(process.env.EXECUTION_CONFIRMATION_TIMEOUT_MS) || 60000,

    EXECUTION_CONFIRMATION_POLL_INTERVAL_MS: Number(process.env.EXECUTION_CONFIRMATION_POLL_INTERVAL_MS) || 2000,

    // Founder Mode (Sprint 2) - the one wallet allowed to reach signing/
    // broadcast while this remains single-user (see
    // services/execution/founderModeGuard.js). null - not a permissive
    // default - means Founder Mode fails closed: no wallet may trade
    // until this is deliberately set to the founder's real Trading
    // Wallet public key. This lock stays in place until Public Alpha.
    FOUNDER_WALLET_PUBLIC_KEY: process.env.FOUNDER_WALLET_PUBLIC_KEY || null,

    // Decision Trace / Explain Mode sprint - off by default (zero extra
    // console output, zero behavior change) so production logs aren't
    // flooded unless deliberately turned on for an audit session. Never
    // changes a decision - see services/decisionEngineV2Adapter.js's own
    // header comment.
    DECISION_ENGINE_V2_EXPLAIN: process.env.DECISION_ENGINE_V2_EXPLAIN === "1" || process.env.DECISION_ENGINE_V2_EXPLAIN === "true"

});

module.exports = config;
