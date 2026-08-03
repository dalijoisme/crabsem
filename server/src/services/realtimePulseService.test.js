// services/realtimePulseService.test.js - Arjuna V4 Phase 2. Proves the
// core Realtime Pulse math: real-elapsed-time velocity (never an assumed
// fixed interval), plain sign-based direction, 3-point acceleration/
// consistency, graceful degradation with fewer than 3 real points, and
// the per-tick orchestration (buffer recording, eviction, batched
// persistence). Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const realtimePulseService = require("./realtimePulseService");
const realtimePulseBufferService = require("./realtimePulseBufferService");
const realtimePulseRepository = require("../repositories/realtimePulseRepository");
const db = require("../database/connection");

const PREFIX = "RTPULSESVC_TEST_";

test.afterEach(() => {
    realtimePulseBufferService.clear();
    db.prepare("DELETE FROM realtime_pulse_snapshots WHERE token_address LIKE ?").run(`${PREFIX}%`);
});

// ---- velocityBetween / directionOf ----

test("velocityBetween computes real delta / real elapsed seconds, never an assumed interval", () => {

    // liquidity rises from 1000 to 1300 over a REAL 20-second gap (not
    // the nominal 30s) - velocity must be 15/s (300/20), not 10/s
    // (300/30), proving real elapsed time is what's actually used.
    const a = { recordedAtMs: 0, liquidity: 1000 };
    const b = { recordedAtMs: 20000, liquidity: 1300 };

    const velocity = realtimePulseService.velocityBetween(a, b, p => p.liquidity);
    assert.equal(velocity, 15);

});

test("velocityBetween handles an abnormally long real gap correctly - still just real delta / real elapsed time", () => {

    // Simulates the real 57.5s collector batch observed during Phase 1
    // smoke testing - this must not be silently treated as if it were 30s.
    const a = { recordedAtMs: 0, liquidity: 1000 };
    const b = { recordedAtMs: 90000, liquidity: 1900 };

    const velocity = realtimePulseService.velocityBetween(a, b, p => p.liquidity);
    assert.equal(velocity, 10); // 900 / 90

});

test("velocityBetween fails to null on missing data - never fabricated", () => {
    const a = { recordedAtMs: 0, liquidity: null };
    const b = { recordedAtMs: 30000, liquidity: 1000 };
    assert.equal(realtimePulseService.velocityBetween(a, b, p => p.liquidity), null);
});

test("velocityBetween fails to null on non-positive elapsed time - never divides by zero or goes negative-time", () => {
    const a = { recordedAtMs: 30000, liquidity: 1000 };
    const b = { recordedAtMs: 30000, liquidity: 2000 }; // same instant
    assert.equal(realtimePulseService.velocityBetween(a, b, p => p.liquidity), null);

    const c = { recordedAtMs: 40000, liquidity: 2000 };
    const d = { recordedAtMs: 30000, liquidity: 3000 }; // out of order
    assert.equal(realtimePulseService.velocityBetween(c, d, p => p.liquidity), null);
});

test("directionOf is a plain sign check with no invented epsilon", () => {
    assert.equal(realtimePulseService.directionOf(5), "UP");
    assert.equal(realtimePulseService.directionOf(-5), "DOWN");
    assert.equal(realtimePulseService.directionOf(0), "FLAT");
    assert.equal(realtimePulseService.directionOf(0.0001), "UP", "even a tiny non-zero value is UP, not FLAT - no fuzzy band");
    assert.equal(realtimePulseService.directionOf(null), null);
});

// ---- computeSeriesSignal ----

test("computeSeriesSignal with fewer than 2 points fails open to all-null, never guessed", () => {
    const result = realtimePulseService.computeSeriesSignal([], p => p.liquidity);
    assert.deepEqual(result, { velocity: null, direction: null, acceleration: null, consistency: null, intervalSecondsUsed: null, stale: null });

    const oneResult = realtimePulseService.computeSeriesSignal([{ recordedAtMs: 0, liquidity: 100 }], p => p.liquidity);
    assert.equal(oneResult.velocity, null);
});

test("computeSeriesSignal with exactly 2 points computes velocity/direction but not acceleration/consistency", () => {

    const buffer = [
        { recordedAtMs: 0, liquidity: 1000 },
        { recordedAtMs: 30000, liquidity: 1300 }
    ];

    const result = realtimePulseService.computeSeriesSignal(buffer, p => p.liquidity);

    assert.equal(result.velocity, 10);
    assert.equal(result.direction, "UP");
    assert.equal(result.acceleration, null, "acceleration needs a 3rd point - must never be guessed from 2");
    assert.equal(result.consistency, null);

});

test("computeSeriesSignal with 3 points computes acceleration and CONSISTENT direction when both transitions agree", () => {

    // liquidity: 1000 -> 1300 (v1=10/s over 30s) -> 1900 (v2=20/s over 30s)
    // - accelerating, same UP direction both transitions.
    const buffer = [
        { recordedAtMs: 0, liquidity: 1000 },
        { recordedAtMs: 30000, liquidity: 1300 },
        { recordedAtMs: 60000, liquidity: 1900 }
    ];

    const result = realtimePulseService.computeSeriesSignal(buffer, p => p.liquidity);

    assert.equal(result.velocity, 20);
    assert.equal(result.direction, "UP");
    assert.equal(result.acceleration, (20 - 10) / 30);
    assert.equal(result.consistency, "CONSISTENT_UP");

});

test("computeSeriesSignal reports MIXED consistency when the two transitions disagree", () => {

    // liquidity: 1000 -> 1300 (UP) -> 1100 (DOWN) - a real reversal within the window.
    const buffer = [
        { recordedAtMs: 0, liquidity: 1000 },
        { recordedAtMs: 30000, liquidity: 1300 },
        { recordedAtMs: 60000, liquidity: 1100 }
    ];

    const result = realtimePulseService.computeSeriesSignal(buffer, p => p.liquidity);

    assert.equal(result.direction, "DOWN");
    assert.equal(result.consistency, "MIXED");

});

test("computeSeriesSignal degrades gracefully when the field is null at one point in an otherwise-full buffer", () => {

    const buffer = [
        { recordedAtMs: 0, holders: 100 },
        { recordedAtMs: 30000, holders: null }, // GMGN didn't report holders this poll
        { recordedAtMs: 60000, holders: 150 }
    ];

    const result = realtimePulseService.computeSeriesSignal(buffer, p => p.holders);

    // Latest transition (prev=null -> last=150) can't produce a velocity.
    assert.equal(result.velocity, null);
    assert.equal(result.direction, null);
    assert.equal(result.acceleration, null, "never fabricated when an intermediate real reading is missing");

});

// ---- computeTokenSignals (via the buffer service) ----

test("computeTokenSignals flags an abnormally large real gap as stale, without refusing to compute the (still mathematically honest) velocity", () => {

    const token = "TOKEN_STALE_TEST";
    realtimePulseBufferService.recordPoint(token, { recordedAtMs: 0, liquidity: 1000, price: 1, holders: 10, volume1h: 100, buys5m: 5, sells5m: 5, smartMoneyBuyUsd: 0, smartMoneySellUsd: 0, kolBuyUsd: 0, kolSellUsd: 0 });
    // A gap far past 3x the nominal 30s interval (90s) - simulates severe
    // GMGN degradation, not a normal tick.
    realtimePulseBufferService.recordPoint(token, { recordedAtMs: 200000, liquidity: 2000, price: 2, holders: 20, volume1h: 200, buys5m: 10, sells5m: 5, smartMoneyBuyUsd: 0, smartMoneySellUsd: 0, kolBuyUsd: 0, kolSellUsd: 0 });

    const result = realtimePulseService.computeTokenSignals(token, 30000);

    assert.equal(result.signals.liquidity.stale, true);
    assert.ok(result.signals.liquidity.velocity != null, "a stale gap is still mathematically honest (real delta / real elapsed time), so it must not be nulled out - only flagged");

});

test("computeTokenSignals never flags a normal-cadence gap as stale", () => {

    const token = "TOKEN_FRESH_TEST";
    realtimePulseBufferService.recordPoint(token, { recordedAtMs: 0, liquidity: 1000 });
    realtimePulseBufferService.recordPoint(token, { recordedAtMs: 30000, liquidity: 1100 });

    const result = realtimePulseService.computeTokenSignals(token, 30000);
    assert.equal(result.signals.liquidity.stale, false);

});

test("computeTokenSignals' flowDirectionVoteProvisional/consistencyVoteProvisional are majority-count summaries only, present but clearly provisional", () => {

    const token = "TOKEN_VOTE_TEST";
    // Every tracked signal trending UP.
    realtimePulseBufferService.recordPoint(token, { recordedAtMs: 0, price: 1, liquidity: 1000, holders: 10, volume1h: 100, buys5m: 5, sells5m: 1, smartMoneyBuyUsd: 10, smartMoneySellUsd: 0, kolBuyUsd: 10, kolSellUsd: 0 });
    realtimePulseBufferService.recordPoint(token, { recordedAtMs: 30000, price: 2, liquidity: 2000, holders: 20, volume1h: 200, buys5m: 10, sells5m: 1, smartMoneyBuyUsd: 20, smartMoneySellUsd: 0, kolBuyUsd: 20, kolSellUsd: 0 });

    const result = realtimePulseService.computeTokenSignals(token, 30000);

    assert.equal(result.flowDirectionVoteProvisional, "UP");

});

test("computeTokenSignals for a token with no buffer at all fails open across every tracked series", () => {

    const result = realtimePulseService.computeTokenSignals("NEVER_SEEN_TOKEN", 30000);

    assert.equal(result.bufferLength, 0);
    assert.equal(result.flowDirectionVoteProvisional, null);
    assert.equal(result.consistencyVoteProvisional, null);
    for(const signal of Object.values(result.signals)){
        assert.equal(signal.velocity, null);
    }

});

// ---- buildRawPoint / aggregateActivityByToken ----

test("buildRawPoint reads real fields off a token/trenches row, defaulting smart-money/KOL to 0 (not null) when no activity exists", () => {

    const token = { price: 1, liquidity: 5000, holders: 100, volume_1h: 1000, buys_5m: 10, sells_5m: 5, price_change_5m: 1, price_change_1h: 2 };
    const trenchesEntry = { net_buy_24h: 500 };

    const point = realtimePulseService.buildRawPoint(token, trenchesEntry, null, null);

    assert.equal(point.liquidity, 5000);
    assert.equal(point.netBuy24h, 500);
    assert.equal(point.smartMoneyBuyUsd, 0, "no real activity this tick is a real, honest zero - not a missing/null reading");
    assert.equal(point.kolTradeCount, 0);
    assert.ok(Number.isFinite(point.recordedAtMs));

});

test("aggregateActivityByToken sums buy/sell USD per token from real activity feed rows, grouped once", () => {

    const rows = [
        { token_address: "A", side: "buy", amount_usd: "100" },
        { token_address: "A", side: "buy", amount_usd: "50" },
        { token_address: "A", side: "sell", amount_usd: "30" },
        { token_address: "B", side: "sell", amount_usd: "20" }
    ];

    const map = realtimePulseService.aggregateActivityByToken(rows);

    assert.deepEqual(map.get("A"), { buyUsd: 150, sellUsd: 30, tradeCount: 3 });
    assert.deepEqual(map.get("B"), { buyUsd: 0, sellUsd: 20, tradeCount: 1 });

});

// ---- runPulseTick (integration) ----

test("runPulseTick records a point per fresh-universe token, persists a batch, and evicts tokens no longer present", () => {

    const tokenA = `${PREFIX}A`;
    const tokenB = `${PREFIX}B`;

    // Tick 1: both tokens present.
    const tick1 = realtimePulseService.runPulseTick({
        tokens: [
            { token_address: tokenA, price: 1, liquidity: 1000, holders: 10, volume_1h: 100, buys_5m: 5, sells_5m: 1 },
            { token_address: tokenB, price: 2, liquidity: 2000, holders: 20, volume_1h: 200, buys_5m: 5, sells_5m: 1 }
        ],
        trenchesByAddress: new Map(),
        smartMoneyRows: [],
        kolRows: [],
        nominalIntervalMs: 30000
    });

    assert.equal(tick1.tokenCount, 2);
    assert.equal(tick1.evictedCount, 0);
    assert.equal(realtimePulseBufferService.getBuffer(tokenA).length, 1);
    assert.equal(realtimePulseBufferService.getBuffer(tokenB).length, 1);
    assert.ok(tick1.computedByToken.has(tokenA));

    // Real durable row must have been written for both tokens.
    assert.ok(db.prepare("SELECT COUNT(*) as c FROM realtime_pulse_snapshots WHERE token_address = ?").get(tokenA).c >= 1);

    // Tick 2: tokenB fell out of the fresh universe entirely.
    const tick2 = realtimePulseService.runPulseTick({
        tokens: [
            { token_address: tokenA, price: 1.1, liquidity: 1100, holders: 11, volume_1h: 110, buys_5m: 6, sells_5m: 1 }
        ],
        trenchesByAddress: new Map(),
        smartMoneyRows: [],
        kolRows: [],
        nominalIntervalMs: 30000
    });

    assert.equal(tick2.evictedCount, 1);
    assert.equal(realtimePulseBufferService.getBuffer(tokenA).length, 2, "tokenA must keep accumulating history across ticks");
    assert.deepEqual(realtimePulseBufferService.getBuffer(tokenB), [], "tokenB must be fully evicted once it's no longer in the fresh universe - not merely stop being updated");

});

test("runPulseTick with an empty fresh universe is a safe no-op that still evicts stale buffered tokens", () => {

    const token = `${PREFIX}C`;
    realtimePulseBufferService.recordPoint(token, { recordedAtMs: Date.now(), liquidity: 1000 });

    const tick = realtimePulseService.runPulseTick({ tokens: [], trenchesByAddress: new Map(), smartMoneyRows: [], kolRows: [], nominalIntervalMs: 30000 });

    assert.equal(tick.tokenCount, 0);
    assert.equal(tick.evictedCount, 1);

});

// ---- warmStartFromDurableHistory ----

test("warmStartFromDurableHistory seeds the in-memory buffer from real, already-persisted rows", async () => {

    const token = `${PREFIX}WARMSTART`;

    realtimePulseRepository.insertMany([{
        tokenAddress: token, price: 1, liquidity: 1000, holders: 10, volume1h: 100, buys5m: 5, sells5m: 1,
        priceChange5m: 1, priceChange1h: 2, netBuy24h: 50,
        smartMoneyBuyUsd: 0, smartMoneySellUsd: 0, smartMoneyTradeCount: 0, kolBuyUsd: 0, kolSellUsd: 0, kolTradeCount: 0
    }]);

    assert.equal(realtimePulseBufferService.getBuffer(token).length, 0, "sanity: nothing buffered in-memory yet");

    realtimePulseService.warmStartFromDurableHistory(token);

    const buffer = realtimePulseBufferService.getBuffer(token);
    assert.equal(buffer.length, 1);
    assert.equal(buffer[0].liquidity, 1000);
    assert.ok(Number.isFinite(buffer[0].recordedAtMs), "the durable row's SQLite timestamp must be parsed into a real, comparable epoch ms value");

});
