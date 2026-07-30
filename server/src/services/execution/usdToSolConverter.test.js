// services/execution/usdToSolConverter.test.js - proves the pure math
// is correct and rounds down (never overspends), and that the price
// lookup reads a real quote's amount_in_usd rather than fabricating a
// number. Fake GMGN client only - no real HTTP calls. Run with
// `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { getSolUsdPrice, usdToLamports, convertUsdPositionToLamports, LAMPORTS_PER_SOL, SOL_MINT, USDC_MINT } = require("./usdToSolConverter");

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
