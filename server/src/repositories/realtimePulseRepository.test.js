// repositories/realtimePulseRepository.test.js - Arjuna V4 Phase 2. Proves
// the durable tier of the Realtime Pulse poll history: batched insert,
// ordered recent-lookback (oldest first, for buffer warm-start), and
// retention pruning. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const realtimePulseRepository = require("./realtimePulseRepository");
const db = require("../database/connection");

const PREFIX = "RTPULSEREPO_TEST_";

function snapshot(tokenAddress, overrides = {}){
    return {
        tokenAddress, price: 0.001, liquidity: 5000, holders: 100, volume1h: 1000,
        buys5m: 10, sells5m: 5, priceChange5m: 1, priceChange1h: 5, netBuy24h: 100,
        smartMoneyBuyUsd: 0, smartMoneySellUsd: 0, smartMoneyTradeCount: 0,
        kolBuyUsd: 0, kolSellUsd: 0, kolTradeCount: 0,
        ...overrides
    };
}

test.afterEach(() => {
    db.prepare("DELETE FROM realtime_pulse_snapshots WHERE token_address LIKE ?").run(`${PREFIX}%`);
});

test("insertMany batches every row in one transaction and countAll reflects it", () => {

    const address = `${PREFIX}A`;
    const inserted = realtimePulseRepository.insertMany([
        snapshot(address, { price: 0.001 }),
        snapshot(address, { price: 0.002 }),
        snapshot(`${PREFIX}B`, { price: 5 })
    ]);

    assert.equal(inserted, 3);
    assert.ok(realtimePulseRepository.countAll() >= 3);

});

test("insertMany with an empty array is a safe no-op", () => {
    assert.equal(realtimePulseRepository.insertMany([]), 0);
});

test("findRecentForToken returns the most recent N rows, oldest first", async () => {

    const address = `${PREFIX}C`;

    // Real, distinguishable rows written one at a time (not batched) so
    // recorded_at ordering is meaningful even at SQLite's 1s timestamp
    // resolution - a tiny real delay between inserts, same convention
    // this codebase's own timing-sensitive tests already accept.
    realtimePulseRepository.insertMany([snapshot(address, { price: 1 })]);
    await new Promise(resolve => setTimeout(resolve, 20));
    realtimePulseRepository.insertMany([snapshot(address, { price: 2 })]);
    await new Promise(resolve => setTimeout(resolve, 20));
    realtimePulseRepository.insertMany([snapshot(address, { price: 3 })]);

    const recent = realtimePulseRepository.findRecentForToken(address, 3);

    assert.equal(recent.length, 3);
    assert.deepEqual(recent.map(r => r.price), [1, 2, 3], "must be returned oldest-first, matching the buffer's own Current/Previous/Previous-Previous ordering");

});

test("findRecentForToken limits to the requested count, still oldest first", async () => {

    const address = `${PREFIX}D`;

    for(const price of [1, 2, 3, 4, 5]){
        realtimePulseRepository.insertMany([snapshot(address, { price })]);
        await new Promise(resolve => setTimeout(resolve, 5));
    }

    const recent = realtimePulseRepository.findRecentForToken(address, 3);

    assert.equal(recent.length, 3);
    assert.deepEqual(recent.map(r => r.price), [3, 4, 5]);

});

test("pruneOlderThan only removes rows past the real age bound", () => {

    const address = `${PREFIX}E`;
    realtimePulseRepository.insertMany([snapshot(address)]);

    // maxAgeHours=1000 must never delete a row inserted moments ago.
    realtimePulseRepository.pruneOlderThan(1000);
    assert.equal(realtimePulseRepository.findRecentForToken(address, 10).length, 1);

    // Backdate the row directly (deterministic - SQLite's CURRENT_TIMESTAMP
    // 1-second resolution makes a real "insert then immediately prune at
    // maxAgeHours=0" boundary flaky, since recorded_at and "now" can land
    // in the same second) rather than relying on real elapsed wall time.
    db.prepare("UPDATE realtime_pulse_snapshots SET recorded_at = datetime('now', '-2 hours') WHERE token_address = ?").run(address);

    const deleted = realtimePulseRepository.pruneOlderThan(1);

    assert.ok(deleted >= 1);
    assert.equal(realtimePulseRepository.findRecentForToken(address, 10).length, 0);

});
