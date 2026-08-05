// scripts/regressionCompare/fixture.js - Regression Comparator.
//
// ONE fixed, deterministic input, used identically by both runHead.js
// and runBaseline.js - the entire point of a scientific comparison is
// that both engine versions see the EXACT same input. Every field here
// is a plain, real-shaped value (no live GMGN data involved - the
// comparator measures the CODE'S request-issuing behavior, never GMGN's
// actual answers). Timestamps are computed fresh at require-time so
// "freshness" gates (both versions have one) always see recent data
// regardless of when this is run.

const nowIso = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// 3 currently-open held positions: one clearly in-profit (above a
// typical 25% take-profit floor), one clearly losing, one roughly flat -
// deliberately spans every isInProfitProtectionTerritory() branch so the
// comparator can show, from REAL execution, exactly which positions each
// engine version chooses to refresh.
const HELD_POSITIONS = [

    {
        id: 9001, token_address: "HeldTokenProfit1111111111111111111111111",
        token_symbol: "PROFIT1", entry_price: 1.0
    },
    {
        id: 9002, token_address: "HeldTokenLosing22222222222222222222222222",
        token_symbol: "LOSING2", entry_price: 1.0
    },
    {
        id: 9003, token_address: "HeldTokenFlat333333333333333333333333333",
        token_symbol: "FLAT3", entry_price: 1.0
    }

];

// Matching gmgn_tokens-shaped rows for the 3 held positions above -
// price reflects each position's real ROI state (PROFIT1 well past a
// 25% floor, LOSING2 down 30%, FLAT3 roughly breakeven).
const HELD_TOKENS_BY_ADDRESS = new Map([
    ["HeldTokenProfit1111111111111111111111111", {
        token_address: "HeldTokenProfit1111111111111111111111111", symbol: "PROFIT1",
        price: 1.35, liquidity: 50000, market_cap: 500000,
        price_change_5m: 3, price_change_1h: 8, volume_1h: 20000,
        updated_at: nowIso(), last_seen: nowIso()
    }],
    ["HeldTokenLosing22222222222222222222222222", {
        token_address: "HeldTokenLosing22222222222222222222222222", symbol: "LOSING2",
        price: 0.70, liquidity: 30000, market_cap: 300000,
        price_change_5m: -4, price_change_1h: -12, volume_1h: 8000,
        updated_at: nowIso(), last_seen: nowIso()
    }],
    ["HeldTokenFlat333333333333333333333333333", {
        token_address: "HeldTokenFlat333333333333333333333333333", symbol: "FLAT3",
        price: 1.02, liquidity: 40000, market_cap: 400000,
        price_change_5m: 0.5, price_change_1h: 1, volume_1h: 12000,
        updated_at: nowIso(), last_seen: nowIso()
    }]
]);

// 3 BUY-tier candidates - already past the entry gate (this comparator
// deliberately does not replay entryGateService/scoring: both are
// AI Decision Engine and both are confirmed, via the earlier source
// audit, to make zero GMGN calls - replaying them would add cost and
// complexity without changing anything about the request PATTERN under
// investigation). Each is handed directly to tradeManager.openPosition(),
// exactly as tradingBotEngine.js's own BUY loop does once entryGateService
// has already said yes.
const BUY_CANDIDATES = [
    {
        token: {
            token_address: "BuyCandidateAlpha1111111111111111111111", symbol: "ALPHA1",
            price: 0.50, liquidity: 25000, market_cap: 250000,
            price_change_5m: 6, price_change_1h: 15, volume_1h: 15000,
            updated_at: nowIso(), last_seen: nowIso()
        },
        live: { action: "BUY", confidence: 65, risk: "MEDIUM", breakdown: null, reasons: [], riskReasons: [] }
    },
    {
        token: {
            token_address: "BuyCandidateBeta222222222222222222222222", symbol: "BETA2",
            price: 0.80, liquidity: 35000, market_cap: 350000,
            price_change_5m: 4, price_change_1h: 10, volume_1h: 18000,
            updated_at: nowIso(), last_seen: nowIso()
        },
        live: { action: "STRONG BUY", confidence: 78, risk: "LOW", breakdown: null, reasons: [], riskReasons: [] }
    },
    {
        token: {
            token_address: "BuyCandidateGamma33333333333333333333333", symbol: "GAMMA3",
            price: 1.20, liquidity: 45000, market_cap: 450000,
            price_change_5m: 2, price_change_1h: 5, volume_1h: 22000,
            updated_at: nowIso(), last_seen: nowIso()
        },
        live: { action: "BUY", confidence: 60, risk: "MEDIUM", breakdown: null, reasons: [], riskReasons: [] }
    }
];

// A real-shaped trading_bot_config row - FIXED_USD sizing so the
// comparator's own request counts never depend on availableCash math,
// only on how many candidates each engine version actually attempts.
const BOT_CONFIG = {
    max_open_positions: 10,
    min_order_size: 5,
    position_sizing_mode: "FIXED_USD",
    fixed_position_size_usd: 10,
    position_size_pct: 20,
    max_position_size: 100,
    exitOverrides: {},
    philosophy: null
};

const AVAILABLE_CASH = 1000;
const USER_ID = 999999;
const WALLET_PUBLIC_KEY = "RegressionComparatorFakeWallet1111111111111";
const CHAIN = "sol";

module.exports = {
    HELD_POSITIONS, HELD_TOKENS_BY_ADDRESS, BUY_CANDIDATES, BOT_CONFIG,
    AVAILABLE_CASH, USER_ID, WALLET_PUBLIC_KEY, CHAIN
};
