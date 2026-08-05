// services/heldPositionMarketStore.test.js - Held-Position Refresh
// Architecture, Phase 1 (Design 1). Proves the store's own contract:
// getFresh only ever returns an entry within the caller's own maxAgeMs,
// a miss is always an honest null (never fabricated/extended), and
// fetchedAt is this store's own real timestamp, never caller-supplied.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const store = require("./heldPositionMarketStore");

test.afterEach(() => {
    store.clear();
});

test("set then getFresh within maxAgeMs returns the real stored price/liquidity", () => {

    store.set("TOKEN_A", { price: 1.23, liquidity: 4500 });

    const entry = store.getFresh("TOKEN_A", 5000);
    assert.equal(entry.price, 1.23);
    assert.equal(entry.liquidity, 4500);

});

test("getFresh returns null for a token that was never fetched - never fabricated", () => {
    assert.equal(store.getFresh("NEVER_SEEN", 60000), null);
});

test("getFresh returns null once the entry is older than the caller's own maxAgeMs, even though get() still returns it", async (t) => {

    t.mock.timers.enable({ apis: ["Date"] });

    store.set("TOKEN_B", { price: 2.0, liquidity: 100 });

    t.mock.timers.tick(5001); // just past a 5000ms freshness window

    assert.equal(store.getFresh("TOKEN_B", 5000), null, "an entry older than maxAgeMs must be an honest miss, never silently accepted");
    assert.ok(store.get("TOKEN_B"), "get() (no freshness requirement) must still return the real, older entry - it exists, it's just not fresh enough for getFresh");

    t.mock.timers.reset();

});

test("getFresh accepts an entry exactly at the boundary and just under it", async (t) => {

    t.mock.timers.enable({ apis: ["Date"] });

    store.set("TOKEN_C", { price: 3.0, liquidity: 200 });

    t.mock.timers.tick(4999);
    assert.ok(store.getFresh("TOKEN_C", 5000), "just under maxAgeMs must be accepted");

    t.mock.timers.reset();

});

test("set overwrites a token's previous entry - last write wins, with a fresh fetchedAt", () => {

    store.set("TOKEN_D", { price: 1.0, liquidity: 10 });
    store.set("TOKEN_D", { price: 1.5, liquidity: 20 });

    const entry = store.getFresh("TOKEN_D", 5000);
    assert.equal(entry.price, 1.5, "the second, newer write must win");
    assert.equal(entry.liquidity, 20);

});

test("a null liquidity is stored and returned honestly, never coerced", () => {

    store.set("TOKEN_E", { price: 1.0, liquidity: null });

    const entry = store.getFresh("TOKEN_E", 5000);
    assert.equal(entry.liquidity, null);

});

test("size() reflects the real number of distinct tokens currently stored", () => {

    assert.equal(store.size(), 0);

    store.set("TOKEN_F", { price: 1, liquidity: 1 });
    store.set("TOKEN_G", { price: 2, liquidity: 2 });
    store.set("TOKEN_F", { price: 3, liquidity: 3 }); // overwrite, not a new entry

    assert.equal(store.size(), 2);

});

test("clear() empties the store - test-only reset", () => {

    store.set("TOKEN_H", { price: 1, liquidity: 1 });
    assert.equal(store.size(), 1);

    store.clear();
    assert.equal(store.size(), 0);
    assert.equal(store.getFresh("TOKEN_H", 60000), null);

});
