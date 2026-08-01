// services/decisionEngineV2Adapter.test.js - Decision Engine V2
// Integration Sprint. Proves the WIRING itself (Layer 1 passthrough,
// historical caching, decision merge, buildRiskBands untouched) - not a
// re-test of productionEngineV2's own scoring (already covered by
// researchEngineFactory.test.js) or of decisionEngineV2.js's 5-layer
// math (already covered by decisionEngineV2.test.js). Uses the real
// database connection (same convention as tradingBotEngine.test.js etc.)
// only for the "real historical data changes the live decision" test -
// every other test monkey-patches productionEngineV2/decisionEngineV2 to
// isolate the adapter's own wiring logic. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const productionV2 = require("./productionEngineV2");
const decisionEngineV2 = require("./decisionEngineV2");
const adapter = require("./decisionEngineV2Adapter");
const db = require("../database/connection");

const PREFIX = "DECISIONENGINEV2ADAPTER_TEST_";

let originalAnalyzeToken, originalAnalyzeTokens, originalBuildRiskBands, originalLoadHistoricalTrades;

test.beforeEach(() => {
    originalAnalyzeToken = productionV2.analyzeToken;
    originalAnalyzeTokens = productionV2.analyzeTokens;
    originalBuildRiskBands = productionV2.buildRiskBands;
    originalLoadHistoricalTrades = decisionEngineV2.loadHistoricalTrades;
    adapter._resetCacheForTests();
});

test.afterEach(() => {
    productionV2.analyzeToken = originalAnalyzeToken;
    productionV2.analyzeTokens = originalAnalyzeTokens;
    productionV2.buildRiskBands = originalBuildRiskBands;
    decisionEngineV2.loadHistoricalTrades = originalLoadHistoricalTrades;
    adapter._resetCacheForTests();
    db.prepare("DELETE FROM trading_bot_trades WHERE token_address LIKE ?").run(`${PREFIX}%`);
    db.prepare("DELETE FROM trading_bot_positions WHERE token_address LIKE ?").run(`${PREFIX}%`);
});

test("getHistoricalIndex builds once and reuses the cache within the refresh window", () => {
    let calls = 0;
    decisionEngineV2.loadHistoricalTrades = () => { calls++; return []; };

    adapter.getHistoricalIndex();
    adapter.getHistoricalIndex();
    adapter.getHistoricalIndex();

    assert.equal(calls, 1, "loadHistoricalTrades must only run once while the cache is still fresh");
});

test("analyzeToken wraps productionEngineV2's base signal, preserving every other field", () => {
    decisionEngineV2.loadHistoricalTrades = () => []; // no history -> fallback, byte-identical action/confidence
    productionV2.analyzeToken = () => ({
        action: "BUY", confidence: 60, risk: "MEDIUM",
        reasons: ["Some feature"], riskReasons: [],
        participantScore: 77, breakdown: { foo: "bar" } // must survive the wrap untouched
    });

    const result = adapter.analyzeToken({ token_address: `${PREFIX}A` });

    assert.equal(result.action, "BUY");
    assert.equal(result.confidence, 60);
    assert.equal(result.participantScore, 77);
    assert.deepEqual(result.breakdown, { foo: "bar" });
    assert.equal(result.decisionEngineV2.fallbackToBaseScoring, true);
});

test("analyzeTokens wraps every element of productionEngineV2's array, preserving order", () => {
    decisionEngineV2.loadHistoricalTrades = () => [];
    productionV2.analyzeTokens = () => ([
        { action: "BUY", confidence: 50, risk: "LOW", reasons: ["X"], riskReasons: [] },
        { action: "HOLD", confidence: 20, risk: "LOW", reasons: ["Y"], riskReasons: [] }
    ]);

    const results = adapter.analyzeTokens([{ token_address: `${PREFIX}A` }, { token_address: `${PREFIX}B` }]);

    assert.equal(results.length, 2);
    assert.equal(results[0].action, "BUY");
    assert.equal(results[1].action, "HOLD");
});

test("buildRiskBands is a pure, untouched passthrough to productionEngineV2 - Decision Engine V2 never computes TP/SL", () => {
    const sentinel = { target: { price: 123 }, stopLoss: { price: 45 } };
    productionV2.buildRiskBands = () => sentinel;

    const result = adapter.buildRiskBands({ token_address: `${PREFIX}A` }, {}, {});

    assert.equal(result, sentinel); // same reference - proves no recomputation, not just equal shape
});

test("real historical data changes the live decision: a BUY with a historically-losing combination is downgraded to HOLD", () => {
    // Seed 6 real closed trades (>= minSampleHardFloor=5) all sharing the
    // same feature, all losses - real DB rows, real join through
    // trading_bot_trades.position_id -> trading_bot_positions.id, exactly
    // the path loadHistoricalTrades() reads in production.
    for(let i = 0; i < 6; i++){
        const posId = db.prepare(`
            INSERT INTO trading_bot_positions (token_address, token_symbol, entry_price, size_usd, status, breakdown_json)
            VALUES (?, 'TEST', 1, 10, 'CLOSED', ?)
        `).run(`${PREFIX}LOSER${i}`, JSON.stringify({ reasons: ["Historically bad feature"] })).lastInsertRowid;

        db.prepare(`
            INSERT INTO trading_bot_trades (token_address, token_symbol, entry_price, exit_price, size_usd, roi_pct, fee_usd, duration_seconds, reason, opened_at, closed_at, position_id)
            VALUES (?, 'TEST', 1, 0.5, 10, -50, 0.1, 60, 'STOP_LOSS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
        `).run(`${PREFIX}LOSER${i}`, posId);
    }

    productionV2.analyzeToken = () => ({
        action: "BUY", confidence: 70, risk: "MEDIUM",
        reasons: ["Historically bad feature"], riskReasons: []
    });

    const result = adapter.analyzeToken({ token_address: `${PREFIX}CANDIDATE` });

    assert.equal(result.action, "HOLD", "a feature combination with 6 real losing trades must downgrade the base engine's BUY");
    assert.equal(result.decisionEngineV2.fallbackToBaseScoring, false);
    assert.equal(result.decisionEngineV2.historical.n, 6);
    assert.equal(result.decisionEngineV2.historical.winRatePct, 0);
});
