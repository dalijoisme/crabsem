// services/execution/usdToSolConverter.test.js - proves the pure math
// is correct and rounds down (never overspends), and that the price
// lookup reads a real quote's amount_in_usd rather than fabricating a
// number. Fake GMGN client only - no real HTTP calls. Run with
// `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { getSolUsdPrice, usdToLamports, convertUsdPositionToLamports, LAMPORTS_PER_SOL, SOL_MINT, USDC_MINT, PRICE_CACHE_TTL_MS, _resetPriceCacheForTest } = require("./usdToSolConverter");

// getSolUsdPrice now caches its result (module-level, shared across
// every caller - see usdToSolConverter.js's own header for why). Reset
// before/after every test so the cache from one test can never leak
// into the next - each test below expects a genuinely fresh probe
// unless it is specifically testing the cache/coalescing behavior.
test.beforeEach(() => { _resetPriceCacheForTest(); });
test.afterEach(() => { _resetPriceCacheForTest(); });

test("usdToLamports converts correctly and rounds DOWN", () => {
    // $150 at $150/SOL = exactly 1 SOL = 1,000,000,000 lamports
    assert.equal(usdToLamports(150, 150), 1_000_000_000);
    // $10 at $73.184/SOL should round down, never up
    const lamports = usdToLamports(10, 73.184);
    assert.equal(lamports, Math.floor((10 / 73.184) * LAMPORTS_PER_SOL));
    assert.ok(lamports / LAMPORTS_PER_SOL * 73.184 <= 10.0000001); // never worth more than what was asked for
});

test("usdToLamports rejects non-positive inputs", () => {
    assert.throws(() => usdToLamports(0, 150), /usdAmount must be a positive number/);
    assert.throws(() => usdToLamports(-5, 150), /usdAmount must be a positive number/);
    assert.throws(() => usdToLamports(10, 0), /solUsdPrice must be a positive number/);
});

test("getSolUsdPrice reads amount_in_usd from a real-shaped quote, requesting exactly 1 SOL", async () => {
    let lastParams = null;
    const gmgnClient = {
        async getSwapQuote(chain, params){
            lastParams = params;
            return { data: { tx: { amount_in_usd: "73.184" } } };
        }
    };

    const price = await getSolUsdPrice(gmgnClient, "SomeWallet111");

    assert.equal(price, 73.184);
    assert.equal(lastParams.inputToken, SOL_MINT);
    assert.equal(lastParams.outputToken, USDC_MINT);
    assert.equal(lastParams.inputAmount, String(LAMPORTS_PER_SOL)); // exactly 1 SOL requested
});

test("getSolUsdPrice throws rather than fabricating a price when the quote has no usable amount_in_usd", async () => {
    const gmgnClient = { async getSwapQuote(){ return { data: { tx: {} } }; } };
    await assert.rejects(() => getSolUsdPrice(gmgnClient, "SomeWallet111"), /did not return a usable amount_in_usd/);
});

test("convertUsdPositionToLamports composes the price lookup and the pure math correctly", async () => {
    const gmgnClient = { async getSwapQuote(){ return { data: { tx: { amount_in_usd: "100" } } }; } };
    const result = await convertUsdPositionToLamports(gmgnClient, "SomeWallet111", 50);
    assert.equal(result.solUsdPrice, 100);
    assert.equal(result.lamports, 500_000_000); // $50 at $100/SOL = 0.5 SOL
});

// GMGN request-volume audit follow-up: this is the actual fix - proves
// two near-simultaneous callers (the real-world shape of
// getDecisionCenter + getTradingConfiguration both firing on the same
// dashboard poll tick) share ONE real quote fetch, never two.
test("getSolUsdPrice coalesces concurrent callers into a single real fetch", async () => {

    let fetchCallCount = 0;
    const gmgnClient = {
        async getSwapQuote(){
            fetchCallCount++;
            return { data: { tx: { amount_in_usd: "150" } } };
        }
    };

    const [priceA, priceB] = await Promise.all([
        getSolUsdPrice(gmgnClient, "WalletA"),
        getSolUsdPrice(gmgnClient, "WalletB")
    ]);

    assert.equal(fetchCallCount, 1, "two callers asking for the price at nearly the same instant must share one real fetch, regardless of which wallet address each one passed");
    assert.equal(priceA, 150);
    assert.equal(priceB, 150);

});

test("getSolUsdPrice serves a cached price within PRICE_CACHE_TTL_MS - never re-fetches", async () => {

    let fetchCallCount = 0;
    const gmgnClient = { async getSwapQuote(){ fetchCallCount++; return { data: { tx: { amount_in_usd: "200" } } }; } };

    const first = await getSolUsdPrice(gmgnClient, "WalletA");
    const second = await getSolUsdPrice(gmgnClient, "WalletB"); // different address, same global price

    assert.equal(fetchCallCount, 1, "the second call must be served from cache, not a fresh fetch");
    assert.equal(first, 200);
    assert.equal(second, 200);

});

test("getSolUsdPrice re-fetches once the cache is older than PRICE_CACHE_TTL_MS - never serves data staler than the TTL", async (t) => {

    t.mock.timers.enable({ apis: ["Date"] });

    let fetchCallCount = 0;
    const gmgnClient = {
        async getSwapQuote(){
            fetchCallCount++;
            return { data: { tx: { amount_in_usd: String(100 + fetchCallCount) } } };
        }
    };

    try{

        const first = await getSolUsdPrice(gmgnClient, "WalletA");
        assert.equal(first, 101);

        t.mock.timers.tick(PRICE_CACHE_TTL_MS + 1);

        const second = await getSolUsdPrice(gmgnClient, "WalletA");
        assert.equal(fetchCallCount, 2, "a call after the TTL has elapsed must trigger a genuinely fresh fetch");
        assert.equal(second, 102, "the second call must see the fresh value, never the stale cached one");

    }
    finally{
        t.mock.timers.reset();
    }

});

test("a failed fetch is never cached - the next call retries live, not permanently poisoned", async () => {

    let fetchCallCount = 0;
    const gmgnClient = {
        async getSwapQuote(){
            fetchCallCount++;
            if(fetchCallCount === 1) return { data: { tx: {} } }; // no usable amount_in_usd - triggers a real throw
            return { data: { tx: { amount_in_usd: "300" } } };
        }
    };

    await assert.rejects(() => getSolUsdPrice(gmgnClient, "WalletA"));

    const price = await getSolUsdPrice(gmgnClient, "WalletA");
    assert.equal(fetchCallCount, 2, "a failed fetch must never be cached - the next call must go live again");
    assert.equal(price, 300);

});
