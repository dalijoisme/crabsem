// services/dynamicExitService.test.js - Arjuna V3 (FINAL SPRINT), Part
// 10: the deterministic exit state machine. Proves each of the 7 steps
// fires exactly when the spec says, in the right priority order, and
// that partial vs full exits are distinguished correctly via the
// returned {action, sellFraction, reason}. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateDynamicExit, MIN_TP_PCT, computeMomentumHealth } = require("./dynamicExitService");
const exitConfig = require("../config/exitSystemConfig");
const momentumHealthConfig = require("../config/momentumHealthConfig");

function position(overrides = {}){
    return {
        entry_price: 1, current_price: 1, mfe_pct: 0, mae_pct: 0, last_volume_1h: 1000,
        tp1_hit_at: null, tp1_price: null,
        ...overrides
    };
}

// A momentum-health fixture that scores comfortably ABOVE both
// exitConfig.emergencyMomentumHealthFloor - so Step 7 never fires as a
// side effect in tests that aren't specifically testing it.
function healthyToken(overrides = {}){
    return {
        token_address: "TEST_HEALTHY",
        price_change_5m: 5, price_change_1h: 10, volume_1h: 1500,
        liquidity: 10000, market_cap: 100000,
        buys_5m: 8, sells_5m: 2,
        ...overrides
    };
}

function healthyTrenches(overrides = {}){
    return { net_buy_24h: 500, raw_json: JSON.stringify({ bot_degen_rate: 0, bundler_trader_amount_rate: 0 }), ...overrides };
}

test("MIN_TP_PCT is aligned to Part 10's TP1 trigger (25), not the old 15", () => {
    assert.equal(MIN_TP_PCT, 25);
    assert.equal(MIN_TP_PCT, exitConfig.tp1.triggerPct);
});

test("Step 1: Hard Stop Loss at -20% from entry_price closes everything, regardless of tp1 state", () => {
    const token = { ...healthyToken(), price: 0.79 }; // -21%
    const result = evaluateDynamicExit({ position: position(), token, trenchesEntry: healthyTrenches() });
    assert.equal(result.action, "SELL_ALL");
    assert.equal(result.sellFraction, 1);
    assert.equal(result.reason, "STOP_LOSS");
});

test("Below TP1 and above Stop Loss: holds", () => {
    const token = { ...healthyToken(), price: 1.10 }; // +10%, below 25% TP1
    const result = evaluateDynamicExit({ position: position(), token, trenchesEntry: healthyTrenches() });
    assert.equal(result.action, "HOLD");
});

test("Step 2/3: TP1 at +25% sells 80% unconditionally (Arjuna V4, Part 3), tp1_hit_at not yet set", () => {
    const token = { ...healthyToken(), price: 1.25 };
    const result = evaluateDynamicExit({ position: position(), token, trenchesEntry: healthyTrenches() });
    assert.equal(result.action, "SELL_PARTIAL");
    assert.equal(result.sellFraction, 0.8);
    assert.equal(result.reason, "TP1");
});

test("TP1 does not re-fire once tp1_hit_at is already set - the position moves to Free Ride Mode", () => {
    const token = { ...healthyToken(), price: 1.25 }; // still exactly at TP1 price
    const pos = position({ tp1_hit_at: "2026-08-02 00:00:00" });
    const result = evaluateDynamicExit({ position: pos, token, trenchesEntry: healthyTrenches() });
    assert.notEqual(result.action, "SELL_PARTIAL");
});

test("Free Ride Mode: post-TP1, below TP2 and timer not expired - holds with no intermediate profit floor", () => {
    const token = { ...healthyToken(), price: 1.10 }; // even a real pullback to +10% must NOT force a sell - no Profit Protection step anymore
    const pos = position({ tp1_hit_at: new Date().toISOString().slice(0, 19).replace("T", " "), mfe_pct: 30 });
    const result = evaluateDynamicExit({ position: pos, token, trenchesEntry: healthyTrenches() });
    assert.equal(result.action, "HOLD");
});

test("Step 4: TP2 at +100% (post-TP1) sells everything remaining", () => {
    const token = { ...healthyToken(), price: 2.00 };
    const pos = position({ tp1_hit_at: new Date().toISOString().slice(0, 19).replace("T", " "), mfe_pct: 100 });
    const result = evaluateDynamicExit({ position: pos, token, trenchesEntry: healthyTrenches() });
    assert.equal(result.action, "SELL_ALL");
    assert.equal(result.sellFraction, 1);
    assert.equal(result.reason, "TP2");
});

test("Step 5: Time Exit - timer expired (5min since TP1) sells the remainder unconditionally, regardless of current ROI", () => {
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const token = { ...healthyToken(), price: 1.20 }; // +20% remaining - well below TP2, timer alone decides
    const pos = position({ tp1_hit_at: sixMinAgo, mfe_pct: 30 });
    const result = evaluateDynamicExit({ position: pos, token, trenchesEntry: healthyTrenches() });
    assert.equal(result.action, "SELL_ALL");
    assert.equal(result.reason, "TIME_EXIT");
});

test("Step 5: Time Exit fires purely on the timer - even a real high mfe_pct that never quite reached TP2 does not save it", () => {
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const token = { ...healthyToken(), price: 1.20 };
    const pos = position({ tp1_hit_at: sixMinAgo, mfe_pct: 95 }); // real peak got close to TP2 (100) but never reached it
    const result = evaluateDynamicExit({ position: pos, token, trenchesEntry: healthyTrenches() });
    assert.equal(result.action, "SELL_ALL");
    assert.equal(result.reason, "TIME_EXIT");
});

test("Step 5: Time Exit does NOT fire before the 5-minute timer has actually expired", () => {
    const oneMinAgo = new Date(Date.now() - 1 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const token = { ...healthyToken(), price: 1.20 };
    const pos = position({ tp1_hit_at: oneMinAgo, mfe_pct: 25 });
    const result = evaluateDynamicExit({ position: pos, token, trenchesEntry: healthyTrenches() });
    assert.equal(result.action, "HOLD");
});

// Step 7 - Emergency Exit. Reuses the exact same real multi-signal
// breakdown fixture the previous sprint's MOMENTUM_HEALTH_BREAKDOWN test
// used, proving the SAME real evidence still triggers an emergency exit -
// just relabeled and now a backstop rather than the primary driver.
const badMomentumToken = {
    token_address: "TEST_MOMENTUM_HEALTH_EMERGENCY",
    price: 1.05, price_change_5m: -5, price_change_1h: 10,
    volume_1h: 100, liquidity: 100, market_cap: 100000,
    buys_5m: 1, sells_5m: 9
};
const badMomentumTrenches = {
    net_buy_24h: -500,
    raw_json: JSON.stringify({
        bot_degen_rate: 0.6, bundler_trader_amount_rate: 0.5, rat_trader_amount_rate: 0.08,
        entrapment_ratio: 0.32, fresh_wallet_rate: 0.6, suspected_insider_hold_rate: 0.08
    })
};

test("Step 7: Emergency Exit fires on real severe structural collapse, even below TP1 and above Stop Loss", () => {
    const result = evaluateDynamicExit({ position: position({ last_volume_1h: 1000 }), token: badMomentumToken, trenchesEntry: badMomentumTrenches });
    assert.equal(result.action, "SELL_ALL");
    assert.equal(result.sellFraction, 1);
    assert.equal(result.reason, "MOMENTUM_HEALTH_EMERGENCY");
    assert.ok(result.momentumHealth.score <= exitConfig.emergencyMomentumHealthFloor);
});

test("Step 7: Emergency Exit never fires on stale market context - never trust uncertain data to force a close", () => {
    const token = { ...badMomentumToken, marketContextStale: true };
    const result = evaluateDynamicExit({ position: position({ last_volume_1h: 1000 }), token, trenchesEntry: badMomentumTrenches });
    assert.notEqual(result.reason, "MOMENTUM_HEALTH_EMERGENCY");
});

test("Step 7: Emergency Exit can override even a post-TP1, otherwise-healthy-looking position", () => {
    const pos = position({ tp1_hit_at: new Date().toISOString().slice(0, 19).replace("T", " "), mfe_pct: 30, last_volume_1h: 1000 });
    const result = evaluateDynamicExit({ position: pos, token: badMomentumToken, trenchesEntry: badMomentumTrenches });
    assert.equal(result.action, "SELL_ALL");
    assert.equal(result.reason, "MOMENTUM_HEALTH_EMERGENCY");
});

test("A genuinely healthy position well above every floor, pre-TP1, just holds - Arjuna's exit stays aggressive/non-conservative", () => {
    const token = { ...healthyToken(), price: 1.15 };
    const result = evaluateDynamicExit({ position: position(), token, trenchesEntry: healthyTrenches() });
    assert.equal(result.action, "HOLD");
    assert.ok(result.momentumHealth.score > exitConfig.emergencyMomentumHealthFloor);
});

test("computeMomentumHealth is unchanged machinery - still returns a neutral score when no real component data exists", () => {
    const health = computeMomentumHealth({ token_address: "TEST_NO_DATA" }, position(), null);
    assert.equal(health.score, 50);
});
