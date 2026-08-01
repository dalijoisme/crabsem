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

// ---------------------------------------------------------------------
// Decision Trace / Explain Mode sprint
// ---------------------------------------------------------------------

function captureConsoleLog(fn){
    const calls = [];
    const original = console.log;
    console.log = (...args) => calls.push(args);
    try{ fn(); }
    finally{ console.log = original; }
    return calls;
}

test("analyzeToken never logs an explain trace by default (env flag off) - production default is silent", () => {
    decisionEngineV2.loadHistoricalTrades = () => [];
    productionV2.analyzeToken = () => ({ action: "BUY", confidence: 60, risk: "MEDIUM", reasons: ["X"], riskReasons: [] });

    const calls = captureConsoleLog(() => adapter.analyzeToken({ token_address: `${PREFIX}A` }));

    assert.equal(calls.filter(c => String(c[0]).includes("decision-engine-v2-explain")).length, 0);
});

test("logExplainTrace logs a full trace for a BUY-tier candidate when explicitly enabled", () => {
    const trace = { baseAction: "BUY", finalAction: "HOLD", historicalCombo: "X", sampleSize: 6 };
    const calls = captureConsoleLog(() => adapter.logExplainTrace({ symbol: "FAKESYM" }, { baseAction: "BUY", trace }, true));

    assert.equal(calls.length, 1);
    assert.ok(String(calls[0][0]).includes("FAKESYM"));
    assert.deepEqual(JSON.parse(calls[0][1]), trace);
});

test("logExplainTrace stays silent for a HOLD/AVOID-tier base action even when explicitly enabled", () => {
    const calls = captureConsoleLog(() => adapter.logExplainTrace({ symbol: "X" }, { baseAction: "HOLD", trace: {} }, true));
    assert.equal(calls.length, 0);
});

test("logExplainTrace stays silent when explicitly disabled, regardless of action tier", () => {
    const calls = captureConsoleLog(() => adapter.logExplainTrace({ symbol: "X" }, { baseAction: "BUY", trace: {} }, false));
    assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------
// Root-cause diagnosis sprint (Qualified BUY = 0) - unconditional pre-V2
// trace. Does NOT depend on DECISION_ENGINE_V2_EXPLAIN - these tests
// never pass/enable that flag, proving the trace fires regardless.
// ---------------------------------------------------------------------

function captureConsole(fn){
    const logs = [];
    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => logs.push(args);
    console.error = (...args) => errors.push(args);
    try{ fn(); }
    finally{ console.log = originalLog; console.error = originalError; }
    return { logs, errors };
}

test("analyzeTokens pre-trace fires unconditionally and reports the real action breakdown, with no explain flag involved", () => {
    decisionEngineV2.loadHistoricalTrades = () => [];
    productionV2.analyzeTokens = () => ([
        { action: "AVOID", confidence: 10, risk: "HIGH", reasons: [], riskReasons: [] },
        { action: "HOLD", confidence: 30, risk: "LOW", reasons: [], riskReasons: [] },
        { action: "BUY", confidence: 65, risk: "MEDIUM", reasons: ["Z"], riskReasons: [] }
    ]);

    const { logs } = captureConsole(() =>
        adapter.analyzeTokens([{ token_address: `${PREFIX}AVOID` }, { token_address: `${PREFIX}HOLD` }, { token_address: `${PREFIX}BUY`, symbol: "BUYSYM" }])
    );

    const summaryLine = logs.find(l => String(l[0]).includes("candidatesSentToV2"));
    assert.ok(summaryLine, "expected the unconditional summary line");
    assert.match(summaryLine[0], /candidatesSentToV2=3/);
    assert.match(summaryLine[0], /"AVOID":1/);
    assert.match(summaryLine[0], /"HOLD":1/);
    assert.match(summaryLine[0], /"BUY":1/);

    // AVOID must be excluded from per-candidate lines (volume control),
    // HOLD and BUY must both appear (both diagnostically relevant).
    const perCandidateLines = logs.filter(l => String(l[0]).includes("token=") && String(l[0]).includes("baseAction"));
    assert.equal(perCandidateLines.length, 2);
    assert.ok(perCandidateLines.some(l => l[0].includes("BUYSYM") && l[0].includes("baseAction=BUY") && l[0].includes("baseConfidence=65")));
    assert.ok(!perCandidateLines.some(l => l[0].includes(`${PREFIX}AVOID`)));
});

test("analyzeTokens pre-trace reports a MISMATCH error when the base engine returns fewer signals than input tokens", () => {
    decisionEngineV2.loadHistoricalTrades = () => [];
    productionV2.analyzeTokens = () => ([{ action: "HOLD", confidence: 20, risk: "LOW", reasons: [], riskReasons: [] }]); // 1 signal for 2 tokens

    const { errors } = captureConsole(() =>
        adapter.analyzeTokens([{ token_address: `${PREFIX}A` }, { token_address: `${PREFIX}B` }])
    );

    assert.ok(errors.some(e => String(e[0]).includes("MISMATCH") && e[0].includes("dropped 1")));
});

test("analyzeTokens surfaces (and rethrows unchanged) an exception from productionV2.analyzeTokens BEFORE Decision Engine V2 is ever reached", () => {
    productionV2.analyzeTokens = () => { throw new Error("simulated base engine failure"); };

    const { errors } = captureConsole(() => {
        assert.throws(() => adapter.analyzeTokens([{ token_address: `${PREFIX}A` }]), /simulated base engine failure/);
    });

    assert.ok(errors.some(e => String(e[0]).includes("productionV2.analyzeTokens THREW") && e[0].includes("NEVER reached")));
});

test("analyzeTokens surfaces (and rethrows unchanged) an exception from inside Decision Engine V2 itself", () => {
    productionV2.analyzeTokens = () => ([{ action: "BUY", confidence: 50, risk: "LOW", reasons: [], riskReasons: [] }]);
    decisionEngineV2.loadHistoricalTrades = () => { throw new Error("simulated DB failure inside Decision Engine V2"); };
    adapter._resetCacheForTests();

    const { errors } = captureConsole(() => {
        assert.throws(() => adapter.analyzeTokens([{ token_address: `${PREFIX}A` }]), /simulated DB failure inside Decision Engine V2/);
    });

    assert.ok(errors.some(e => String(e[0]).includes("applyDecisionEngineV2/evaluateV2 THREW")));
});

test("analyzeToken (singular) pre-trace also fires unconditionally, before Decision Engine V2 runs", () => {
    decisionEngineV2.loadHistoricalTrades = () => [];
    productionV2.analyzeToken = () => ({ action: "STRONG BUY", confidence: 80, risk: "LOW", reasons: [], riskReasons: [] });

    const { logs } = captureConsole(() => adapter.analyzeToken({ token_address: `${PREFIX}X`, symbol: "SINGLESYM" }));

    assert.ok(logs.some(l => l[0].includes("SINGLESYM") && l[0].includes("baseAction=STRONG BUY") && l[0].includes("baseConfidence=80")));
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
