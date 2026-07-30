// services/execution/executionGuard.test.js - proves each check
// rejects independently for a specific, descriptive reason, and that a
// clean quote passes through untouched. Fixtures shaped exactly like
// the REAL GET /v1/trade/quote response captured live during the GMGN
// verification sprint. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { assertQuoteIsSafeToExecute } = require("./executionGuard");

function realShapedQuote(overrides = {}){
    return {
        input_amount: "1000000",
        output_amount: "73124",
        min_output_amount: "65811",
        slippage: 10,
        tx: {
            quote: {
                priceImpactPct: "0",
                routePlan: [{ swapInfo: { label: "Orca" }, percent: 100 }]
            },
            raw_tx: { recentBlockhash: "abc", lastValidBlockHeight: 435965729 }
        },
        ...overrides
    };
}

test("a clean, real-shaped quote passes and returns the parsed facts", () => {
    const result = assertQuoteIsSafeToExecute(realShapedQuote());
    assert.deepEqual(result, { priceImpactPct: 0, requestedSlippagePct: 10, routeHops: 1 });
});

test("rejects excessive price impact", () => {
    const quote = realShapedQuote({ tx: { quote: { priceImpactPct: "8.5", routePlan: [{}] }, raw_tx: {} } });
    assert.throws(() => assertQuoteIsSafeToExecute(quote, { maxPriceImpactPct: 5 }), /price impact 8\.5% exceeds/);
});

test("rejects slippage above the configured limit", () => {
    const quote = realShapedQuote({ slippage: 25 });
    assert.throws(() => assertQuoteIsSafeToExecute(quote, { maxSlippagePct: 15 }), /slippage 25% exceeds/);
});

test("rejects an empty route", () => {
    const quote = realShapedQuote({ tx: { quote: { priceImpactPct: "0", routePlan: [] }, raw_tx: {} } });
    assert.throws(() => assertQuoteIsSafeToExecute(quote), /no route/);
});

test("rejects a route with too many hops", () => {
    const quote = realShapedQuote({ tx: { quote: { priceImpactPct: "0", routePlan: [{}, {}, {}, {}] }, raw_tx: {} } });
    assert.throws(() => assertQuoteIsSafeToExecute(quote, { maxRouteHops: 3 }), /4 hops, exceeding the 3-hop limit/);
});

test("rejects a non-positive output amount", () => {
    const quote = realShapedQuote({ output_amount: "0" });
    assert.throws(() => assertQuoteIsSafeToExecute(quote), /non-positive output amount/);
});

test("limits are independently configurable and default sensibly when omitted", () => {
    const quote = realShapedQuote({ slippage: 10, tx: { quote: { priceImpactPct: "4.9", routePlan: [{}] }, raw_tx: {} } });
    assert.doesNotThrow(() => assertQuoteIsSafeToExecute(quote)); // within all defaults
});
