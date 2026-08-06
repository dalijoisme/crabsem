// services/dynamicExitService.test.js - Arjuna V3 (FINAL SPRINT), Part
// 10: the deterministic exit state machine. Proves each of the 7 steps
// fires exactly when the spec says, in the right priority order, and
// that partial vs full exits are distinguished correctly via the
// returned {action, sellFraction, reason}. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    evaluateDynamicExit, MIN_TP_PCT, computeMomentumHealth,
    resolveEffectiveStopLossPct, resolveEffectiveTp1TriggerPct, resolveEffectiveTp2Pct, resolveEffectiveTimerMinutes
} = require("./dynamicExitService");
const exitConfig = require("../config/exitSystemConfig");
const momentumHealthConfig = require("../config/momentumHealthConfig");
const realtimePulseBufferService = require("./realtimePulseBufferService");

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

// Arjuna V4 Phase 2 (Momentum Weakening Evolution) - proves the new
// optional realtimeSignal parameter is purely additive: score/components
// are byte-identical with or without it, and it's only ever attached as
// realtimeFacts.
test("computeMomentumHealth attaches realtimeSignal as realtimeFacts without changing score/components at all", () => {

    const withoutSignal = computeMomentumHealth(healthyToken(), position(), healthyTrenches());
    const fakeSignal = { tokenAddress: "TEST_HEALTHY", bufferLength: 3, signals: {}, flowDirectionVoteProvisional: "UP" };
    const withSignal = computeMomentumHealth(healthyToken(), position(), healthyTrenches(), fakeSignal);

    assert.equal(withSignal.score, withoutSignal.score);
    assert.deepEqual(withSignal.components, withoutSignal.components);
    assert.equal(withoutSignal.realtimeFacts, null, "omitted realtimeSignal must fail open to null, never fabricated");
    assert.deepEqual(withSignal.realtimeFacts, fakeSignal);

});

// Arjuna V4 FINAL DECISION ENGINE SPRINT - Dynamic TP/SL/Adaptive Time
// Exit are now real. Every resolver reuses the SAME ±15% Realtime Pulse
// figure the Architect specified for the entry side (see
// REALTIME_EXIT_ADJUSTMENT_PCT's own header) - proven exactly here.
test("resolveEffective* TP/SL/Timer hooks are neutral (exitConfig's baseline) with no realtime signal at all", () => {

    const pos = position();
    const token = healthyToken();

    assert.equal(resolveEffectiveStopLossPct(pos, token, undefined), exitConfig.hardStopLossPct);
    assert.equal(resolveEffectiveTp1TriggerPct(pos, token, null), exitConfig.tp1.triggerPct);
    assert.equal(resolveEffectiveTp2Pct(pos, token, {}), exitConfig.tp2Pct);
    assert.equal(resolveEffectiveTimerMinutes(pos, token, { flowDirectionVoteProvisional: "MIXED" }), exitConfig.timerMinutes);

});

test("weakening momentum tightens Stop Loss/TP1/TP2/Timer by exactly the Architect's ±15% figure", () => {

    const pos = position();
    const token = healthyToken();
    const weakening = { flowDirectionVoteProvisional: "DOWN", consistencyVoteProvisional: "MOSTLY_CONSISTENT" };

    assert.equal(resolveEffectiveStopLossPct(pos, token, weakening), exitConfig.hardStopLossPct * 0.85);
    assert.equal(resolveEffectiveTp1TriggerPct(pos, token, weakening), exitConfig.tp1.triggerPct * 0.85);
    assert.equal(resolveEffectiveTp2Pct(pos, token, weakening), exitConfig.tp2Pct * 0.85);
    assert.equal(resolveEffectiveTimerMinutes(pos, token, weakening), exitConfig.timerMinutes * 0.85);

});

test("improving momentum widens TP1/TP2/Timer, but NEVER loosens Stop Loss - capital protection is never traded away for a marginal upside", () => {

    const pos = position();
    const token = healthyToken();
    const improving = { flowDirectionVoteProvisional: "UP", consistencyVoteProvisional: "MOSTLY_CONSISTENT" };

    assert.equal(resolveEffectiveStopLossPct(pos, token, improving), exitConfig.hardStopLossPct, "Stop Loss must stay at the full baseline under improving momentum, never loosened");
    assert.equal(resolveEffectiveTp1TriggerPct(pos, token, improving), exitConfig.tp1.triggerPct * 1.15);
    assert.equal(resolveEffectiveTp2Pct(pos, token, improving), exitConfig.tp2Pct * 1.15);
    assert.equal(resolveEffectiveTimerMinutes(pos, token, improving), exitConfig.timerMinutes * 1.15);

});

test("an UP direction WITHOUT consistent agreement is not 'improving' - TP1/TP2/Timer stay at baseline, not widened on a noisy single reading", () => {

    const pos = position();
    const token = healthyToken();
    const noisyUp = { flowDirectionVoteProvisional: "UP", consistencyVoteProvisional: "MOSTLY_MIXED" };

    assert.equal(resolveEffectiveTp1TriggerPct(pos, token, noisyUp), exitConfig.tp1.triggerPct);
    assert.equal(resolveEffectiveTimerMinutes(pos, token, noisyUp), exitConfig.timerMinutes);

});

test("resolveEffectiveTimerMinutes never collapses below the floor even under repeated weakening", () => {
    const pos = position();
    const token = healthyToken();
    const weakening = { flowDirectionVoteProvisional: "DOWN" };
    assert.ok(resolveEffectiveTimerMinutes(pos, token, weakening) >= 1);
});

// Arjuna V4 Phase 2 (Realtime position monitoring improvements) - proves
// evaluateDynamicExit reads a real, buffered Realtime Pulse signal for
// the held position's own token (not a hardcoded neutral), and that its
// presence changes only observability (momentumHealth.realtimeFacts),
// never the actual exit decision for an otherwise-healthy position.
test("evaluateDynamicExit reads the token's own real Realtime Pulse buffer into momentumHealth.realtimeFacts, without changing the HOLD decision", () => {

    const token = { ...healthyToken(), token_address: "TEST_PULSE_WIRING", price: 1.15 };

    realtimePulseBufferService.recordPoint("TEST_PULSE_WIRING", { recordedAtMs: Date.now() - 30000, liquidity: 1000 });
    realtimePulseBufferService.recordPoint("TEST_PULSE_WIRING", { recordedAtMs: Date.now(), liquidity: 2000 });

    try{

        const result = evaluateDynamicExit({ position: position(), token, trenchesEntry: healthyTrenches() });

        assert.equal(result.action, "HOLD", "a neutral/single-series-only buffer (mfe_pct:0, mae_pct:0) must not itself trigger any of the new momentum-aware exit rules");
        assert.ok(result.momentumHealth.realtimeFacts, "the real buffer must have been read, not skipped");
        assert.equal(result.momentumHealth.realtimeFacts.bufferLength, 2);
        assert.equal(result.momentumHealth.realtimeFacts.signals.liquidity.direction, "UP");

    }
    finally{
        realtimePulseBufferService.clear();
    }

});

// Arjuna V4 FINAL DECISION ENGINE SPRINT - Architect's own explicit
// rule: "If Momentum weakens AND MFE >15%: Exit earlier." Uses the
// position's own real, already-tracked mfe_pct (not the current roiPct),
// per this file's own header comment on why.
test("MOMENTUM_WEAKENING_EARLY_EXIT fires when a real MFE >15% was reached and momentum is now weakening", () => {

    const address = "TEST_MOMENTUM_EARLY_EXIT";
    const token = { ...healthyToken(), token_address: address, price: 1.10 }; // currently only +10%, well below TP1

    realtimePulseBufferService.recordPoint(address, { recordedAtMs: Date.now() - 30000, liquidity: 2000, volume1h: 200, buys5m: 10, sells5m: 1 });
    realtimePulseBufferService.recordPoint(address, { recordedAtMs: Date.now(), liquidity: 1000, volume1h: 100, buys5m: 2, sells5m: 10 }); // real, consistent DOWN

    try{

        const pos = position({ mfe_pct: 20 }); // a real, already-recorded peak of +20%, well above the 15% bar
        const result = evaluateDynamicExit({ position: pos, token, trenchesEntry: healthyTrenches() });

        assert.equal(result.action, "SELL_ALL");
        assert.equal(result.reason, "MOMENTUM_WEAKENING_EARLY_EXIT");

    }
    finally{
        realtimePulseBufferService.clear();
    }

});

test("MOMENTUM_WEAKENING_EARLY_EXIT does NOT fire when MFE never exceeded 15%, even with weakening momentum", () => {

    const address = "TEST_MOMENTUM_EARLY_EXIT_LOW_MFE";
    const token = { ...healthyToken(), token_address: address, price: 1.05 };

    realtimePulseBufferService.recordPoint(address, { recordedAtMs: Date.now() - 30000, liquidity: 2000, volume1h: 200, buys5m: 10, sells5m: 1 });
    realtimePulseBufferService.recordPoint(address, { recordedAtMs: Date.now(), liquidity: 1000, volume1h: 100, buys5m: 2, sells5m: 10 });

    try{

        const pos = position({ mfe_pct: 10 }); // real peak, but below the 15% bar
        const result = evaluateDynamicExit({ position: pos, token, trenchesEntry: healthyTrenches() });

        assert.notEqual(result.reason, "MOMENTUM_WEAKENING_EARLY_EXIT");

    }
    finally{
        realtimePulseBufferService.clear();
    }

});

// Arjuna V4 FINAL DECISION ENGINE SPRINT - Architect's own explicit
// rule: "If MAE expands AND Realtime momentum weakens: Accelerate exit."
// "Expands" = a real, already-existing drawdown (mae_pct < 0) getting
// WORSE this exact cycle (a new low), per this file's own header.
test("MAE_ACCELERATED_EXIT fires when a real, already-existing drawdown gets worse this cycle while momentum weakens", () => {

    const address = "TEST_MAE_ACCELERATED";
    // roiPct at this price is worse than the position's own prior mae_pct below - a genuine new low this cycle.
    const token = { ...healthyToken(), token_address: address, price: 0.92 }; // -8% this cycle

    realtimePulseBufferService.recordPoint(address, { recordedAtMs: Date.now() - 30000, liquidity: 2000, volume1h: 200, buys5m: 10, sells5m: 1 });
    realtimePulseBufferService.recordPoint(address, { recordedAtMs: Date.now(), liquidity: 1000, volume1h: 100, buys5m: 2, sells5m: 10 });

    try{

        const pos = position({ mae_pct: -5 }); // prior worst was -5%; this cycle's -8% is a real new low
        const result = evaluateDynamicExit({ position: pos, token, trenchesEntry: healthyTrenches() });

        assert.equal(result.action, "SELL_ALL");
        assert.equal(result.reason, "MAE_ACCELERATED_EXIT");

    }
    finally{
        realtimePulseBufferService.clear();
    }

});

test("MAE_ACCELERATED_EXIT does NOT fire when mae_pct has never gone negative - there is nothing real to 'expand'", () => {

    const address = "TEST_MAE_NO_PRIOR_DRAWDOWN";
    const token = { ...healthyToken(), token_address: address, price: 0.99 };

    realtimePulseBufferService.recordPoint(address, { recordedAtMs: Date.now() - 30000, liquidity: 2000, volume1h: 200, buys5m: 10, sells5m: 1 });
    realtimePulseBufferService.recordPoint(address, { recordedAtMs: Date.now(), liquidity: 1000, volume1h: 100, buys5m: 2, sells5m: 10 });

    try{

        const pos = position({ mae_pct: 0 }); // never dipped negative
        const result = evaluateDynamicExit({ position: pos, token, trenchesEntry: healthyTrenches() });

        assert.notEqual(result.reason, "MAE_ACCELERATED_EXIT");

    }
    finally{
        realtimePulseBufferService.clear();
    }

});

test("MAE_ACCELERATED_EXIT does NOT fire on a real new low WITHOUT weakening momentum confirming it", () => {

    const address = "TEST_MAE_NO_WEAKENING_CONFIRM";
    const token = { ...healthyToken(), token_address: address, price: 0.92 };

    // Consistent UP buffer - a real new ROI low without any real-time
    // weakening signal to confirm it (e.g. a single bad price tick amid
    // otherwise-improving flow) must not accelerate the exit.
    realtimePulseBufferService.recordPoint(address, { recordedAtMs: Date.now() - 30000, liquidity: 1000, volume1h: 100, buys5m: 2, sells5m: 10 });
    realtimePulseBufferService.recordPoint(address, { recordedAtMs: Date.now(), liquidity: 2000, volume1h: 200, buys5m: 10, sells5m: 1 });

    try{

        const pos = position({ mae_pct: -5 });
        const result = evaluateDynamicExit({ position: pos, token, trenchesEntry: healthyTrenches() });

        assert.notEqual(result.reason, "MAE_ACCELERATED_EXIT");

    }
    finally{
        realtimePulseBufferService.clear();
    }

});

// Graceful-degradation fix (production trading-quality audit,
// 2026-08-06, live VPS) - see this block's own header comment in
// dynamicExitService.js for the real production evidence: every real
// STOP_LOSS decision sampled from live logs showed realtimePulseFlow=n/a
// (an empty/insufficient buffer - the common case for a young position,
// not an edge case) far more often than a real "not weakening" vote,
// silently disabling this entire protection for the trades that needed
// it most (median realized loss -36.9% against a -20% configured
// floor). The critical property under test: a real new low with NO
// buffer data at all (empty buffer - never recorded a single point, so
// flowDirectionVoteProvisional is genuinely null, not a real "UP"/"MIXED"
// vote) must now fall back to firing on the raw mae_pct signal alone -
// this is the ONLY behavior change from the three tests above, which
// must all keep passing unmodified.
test("MAE_ACCELERATED_EXIT_NO_SIGNAL fires on a real new low when no realtime buffer data exists at all (the common real-production case)", () => {

    const address = "TEST_MAE_NO_BUFFER_AT_ALL";
    const token = { ...healthyToken(), token_address: address, price: 0.92 };
    // Deliberately no realtimePulseBufferService.recordPoint() calls -
    // an empty buffer, exactly matching a brand-new position that
    // hasn't had time to accumulate the 2+ ticks a direction vote needs.

    try{

        const pos = position({ mae_pct: -5 });
        const result = evaluateDynamicExit({ position: pos, token, trenchesEntry: healthyTrenches() });

        assert.equal(result.action, "SELL_ALL");
        assert.equal(result.reason, "MAE_ACCELERATED_EXIT_NO_SIGNAL");

    }
    finally{
        realtimePulseBufferService.clear();
    }

});
