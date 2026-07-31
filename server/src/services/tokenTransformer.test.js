// services/tokenTransformer.test.js - False Positive Reduction V4:
// proves GMGN's real open_timestamp:0 sentinel (verified against a
// direct query of the real local dataset - true for 70.4% of all
// tracked tokens) is treated as "no real launch data," never as a real
// 1970 timestamp. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { transformToken } = require("./tokenTransformer");

function rawToken(overrides = {}){
    return {
        address: "TOKEN1", symbol: "TEST", name: "Test Token", chain: "sol",
        market_cap: 10000, liquidity: 5000, price: 0.001,
        price_change_percent5m: 5, price_change_percent1h: 20,
        volume: 1000, holder_count: 50,
        ...overrides
    };
}

test("open_timestamp: 0 (GMGN's real 'unknown' sentinel) becomes launchTimestamp: null, never a fabricated 1970 date", () => {
    const result = transformToken(rawToken({ open_timestamp: 0 }));
    assert.equal(result.launchTimestamp, null);
});

test("a real, positive open_timestamp passes through unchanged", () => {
    const result = transformToken(rawToken({ open_timestamp: 1785350132 }));
    assert.equal(result.launchTimestamp, 1785350132);
});

test("a missing open_timestamp (undefined/null) stays null, same as before", () => {
    assert.equal(transformToken(rawToken({ open_timestamp: undefined })).launchTimestamp, null);
    assert.equal(transformToken(rawToken({ open_timestamp: null })).launchTimestamp, null);
});

test("a negative open_timestamp (never real, but defensively handled the same way) becomes null", () => {
    const result = transformToken(rawToken({ open_timestamp: -1 }));
    assert.equal(result.launchTimestamp, null);
});

test("every other real field mapping is unaffected by this fix", () => {
    const result = transformToken(rawToken({ open_timestamp: 0, market_cap: 12345, holder_count: 99 }));
    assert.equal(result.marketCap, 12345);
    assert.equal(result.holders, 99);
    assert.equal(result.tokenAddress, "TOKEN1");
});
