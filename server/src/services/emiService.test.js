// services/emiService.test.js - unit tests for the pure classifier
// (classify() takes plain data, no DB access). Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const emiService = require("./emiService");

function sqliteTimestampMinutesAgo(minutes){
    return new Date(Date.now() - minutes * 60000).toISOString().slice(0, 19).replace("T", " ");
}

function freshToken(overrides){
    return {
        token_address: "X",
        launch_time: sqliteTimestampMinutesAgo(10), // 10 minutes old - well within the 12h window
        price_change_5m: 0,
        price_change_1h: 0,
        ...overrides
    };
}

test("classify() returns NO_AGE_DATA when neither launch_time nor created_timestamp exists", () => {
    const result = emiService.classify({ token_address: "X" }, null, null);
    assert.equal(result.accelerating, false);
    assert.equal(result.reason, "NO_AGE_DATA");
});

test("classify() returns TOO_MATURE for a token older than 12h even with real acceleration", () => {
    const token = freshToken({ launch_time: sqliteTimestampMinutesAgo(800), price_change_5m: 20, price_change_1h: 10 });
    const result = emiService.classify(token, null, null);
    assert.equal(result.accelerating, false);
    assert.equal(result.reason, "TOO_MATURE");
});

test("classify() falls back to gmgn_trenches.created_timestamp (unix seconds) when launch_time is absent", () => {
    const token = { token_address: "X", price_change_5m: 0, price_change_1h: 0 };
    const tenMinutesAgoEpochSeconds = Math.floor((Date.now() - 10 * 60000) / 1000);
    const result = emiService.classify(token, { created_timestamp: tenMinutesAgoEpochSeconds }, null);
    // No acceleration signals present, but age resolution must have
    // succeeded (not NO_AGE_DATA) for this to reach NOT_ACCELERATING.
    assert.equal(result.reason, "NOT_ACCELERATING");
});

test("classify() detects price-only acceleration via the breakoutHunter formula (5m pace outrunning 1h)", () => {
    const token = freshToken({ price_change_5m: 10, price_change_1h: 50 }); // 10*12=120 > 50
    const result = emiService.classify(token, null, null);
    assert.equal(result.accelerating, true);
    assert.equal(result.reason, "PRICE_ACCELERATION_ONLY");
});

test("classify() does NOT flag acceleration when 5m pace does not outrun 1h", () => {
    const token = freshToken({ price_change_5m: 1, price_change_1h: 50 }); // 1*12=12, not > 50
    const result = emiService.classify(token, null, null);
    assert.equal(result.accelerating, false);
    assert.equal(result.reason, "NOT_ACCELERATING");
});

test("classify() detects signal-only acceleration from a fresh, hot decision-log row", () => {
    const token = freshToken();
    const historyRows = [{ trigger_reason: "PARTICIPANT_SCORE_CHANGED_SIGNIFICANTLY", prediction_time: sqliteTimestampMinutesAgo(5) }];
    const result = emiService.classify(token, null, historyRows);
    assert.equal(result.accelerating, true);
    assert.equal(result.reason, "SIGNAL_ACCELERATION_ONLY");
});

test("classify() ignores a hot trigger reason once it is older than the 15-minute freshness window", () => {
    const token = freshToken();
    const historyRows = [{ trigger_reason: "PARTICIPANT_SCORE_CHANGED_SIGNIFICANTLY", prediction_time: sqliteTimestampMinutesAgo(30) }];
    const result = emiService.classify(token, null, historyRows);
    assert.equal(result.accelerating, false);
    assert.equal(result.reason, "NOT_ACCELERATING");
});

test("classify() ignores FIRST_DECISION_FOR_TOKEN and FIXED_REFRESH_TIMEOUT as 'cold', not hot", () => {
    const token = freshToken();
    for(const reason of ["FIRST_DECISION_FOR_TOKEN", "FIXED_REFRESH_TIMEOUT"]){
        const historyRows = [{ trigger_reason: reason, prediction_time: sqliteTimestampMinutesAgo(1) }];
        const result = emiService.classify(token, null, historyRows);
        assert.equal(result.accelerating, false, `${reason} must not count as signal acceleration`);
    }
});

test("classify() returns SIGNAL_AND_PRICE_ACCELERATION when both real signals fire", () => {
    const token = freshToken({ price_change_5m: 10, price_change_1h: 50 });
    const historyRows = [{ trigger_reason: "VOLUME_SPIKE", prediction_time: sqliteTimestampMinutesAgo(2) }];
    const result = emiService.classify(token, null, historyRows);
    assert.equal(result.accelerating, true);
    assert.equal(result.reason, "SIGNAL_AND_PRICE_ACCELERATION");
});

test("classifyMany() batches over a token list using a shared batchContext, one entry per token", () => {
    const tokens = [freshToken({ token_address: "X", price_change_5m: 10, price_change_1h: 50 }), freshToken({ token_address: "Y" })];
    const batchContext = { trenchesByToken: new Map(), historyByToken: new Map() };
    const result = emiService.classifyMany(tokens, batchContext);
    assert.equal(result.size, 2);
    assert.equal(result.get("X").accelerating, true);
    assert.equal(result.get("Y").accelerating, false);
});

// Ranking-priority fix: signalAcceleration used to read prediction_history -
// the STABLE-only house cache - which AGGRESSIVE's real per-cycle scoring
// never writes to. When a real acceleration signal is supplied, its own
// gatePassed must be what decides signal-acceleration, not stale/absent
// history - and a hot-looking but now-inert history row must NOT win.
test("classify() uses the real acceleration signal's gatePassed over prediction_history when supplied", () => {

    const token = freshToken();

    // A hot-looking history row alone (no acceleration param) still
    // triggers signal acceleration exactly as before.
    const hotHistory = [{ trigger_reason: "PARTICIPANT_SCORE_CHANGED_SIGNIFICANTLY", prediction_time: sqliteTimestampMinutesAgo(2) }];
    const withoutAccel = emiService.classify(token, null, hotHistory);
    assert.equal(withoutAccel.reason, "SIGNAL_ACCELERATION_ONLY");

    // The SAME hot-looking history row must be IGNORED once a real
    // acceleration signal is supplied and reports nothing happening now.
    const inertAcceleration = { priceAccel: 0, flowAccel: 0, liquidityAccel: 0, compositeScore: 0, gatePassed: false };
    const withInertAccel = emiService.classify(token, null, hotHistory, inertAcceleration);
    assert.equal(withInertAccel.accelerating, false);
    assert.equal(withInertAccel.reason, "NOT_ACCELERATING");

    // And a real, currently-passing acceleration signal must flag
    // acceleration even with no history at all.
    const realAcceleration = { priceAccel: 1, flowAccel: 1, liquidityAccel: 1, compositeScore: 1, gatePassed: true };
    const withRealAccel = emiService.classify(token, null, null, realAcceleration);
    assert.equal(withRealAccel.accelerating, true);
    assert.equal(withRealAccel.reason, "SIGNAL_ACCELERATION_ONLY");

});

test("classifyMany() threads accelerationByAddress through per-token, absent entries fall back unchanged", () => {
    const tokens = [freshToken({ token_address: "X" }), freshToken({ token_address: "Y" })];
    const batchContext = { trenchesByToken: new Map(), historyByToken: new Map() };
    const accelerationByAddress = new Map([["X", { priceAccel: 1, flowAccel: 1, liquidityAccel: 1, compositeScore: 1, gatePassed: true }]]);
    const result = emiService.classifyMany(tokens, batchContext, accelerationByAddress);
    assert.equal(result.get("X").accelerating, true);
    assert.equal(result.get("Y").accelerating, false); // no entry in the map -> undefined -> today's fallback behavior
});
