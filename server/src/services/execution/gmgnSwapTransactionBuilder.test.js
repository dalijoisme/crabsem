// services/execution/gmgnSwapTransactionBuilder.test.js - proves every
// guard runs in the right order (Founder Mode first, before any network
// call; then input validation; then a real quote call; then the
// Execution Guard against it), that build() performs NO irreversible
// action (only submit() does, called separately - see
// executionService.js), and that submit() calls the real, confirmed
// POST /v1/trade/swap contract and returns a real transaction hash.
// Fake GMGN client only - no real HTTP calls anywhere in this file.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGmgnSwapTransactionBuilder, SOL_MINT } = require("./gmgnSwapTransactionBuilder");

const FOUNDER_WALLET = "FounderWallet1111111111111111111111111111";
const TOKEN = "SomeTokenAddress1111111111111111111111111";

function fakeGmgnClient({ quoteResponse, swapResponse } = {}){
    let quoteCallCount = 0;
    let swapCallCount = 0;
    let lastQuoteParams = null;
    let lastSwapParams = null;
    return {
        quoteCallCount: () => quoteCallCount,
        swapCallCount: () => swapCallCount,
        lastQuoteParams: () => lastQuoteParams,
        lastSwapParams: () => lastSwapParams,
        async getSwapQuote(chain, params){
            quoteCallCount++;
            lastQuoteParams = params;
            if(quoteResponse instanceof Error) throw quoteResponse;
            return { data: quoteResponse ?? realShapedQuote() };
        },
        async submitSwap(chain, params){
            swapCallCount++;
            lastSwapParams = params;
            if(swapResponse instanceof Error) throw swapResponse;
            return { data: swapResponse ?? realShapedSwapResponse() };
        }
    };
}

function realShapedQuote(overrides = {}){
    return {
        input_amount: "1000000", output_amount: "73124", min_output_amount: "65811", slippage: 10,
        tx: { quote: { priceImpactPct: "0", routePlan: [{ swapInfo: { label: "Orca" } }] }, raw_tx: {} },
        ...overrides
    };
}

function realShapedSwapResponse(overrides = {}){
    return { order_id: "order-abc-123", hash: "RealTxSignature111", status: "pending", ...overrides };
}

const config = { FOUNDER_WALLET_PUBLIC_KEY: FOUNDER_WALLET };

test("rejects a non-founder wallet before any GMGN call is made", async () => {
    const gmgnClient = fakeGmgnClient();
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    await assert.rejects(
        () => builder.build({ userId: 1, walletPublicKey: "SomeoneElse111", action: "BUY", amountLamports: 1000000, tokenAddress: TOKEN }),
        /not the configured Founder Trading Wallet/
    );
    assert.equal(gmgnClient.quoteCallCount(), 0);
});

test("rejects when Founder Mode is unconfigured, before any GMGN call", async () => {
    const gmgnClient = fakeGmgnClient();
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config: { FOUNDER_WALLET_PUBLIC_KEY: null } });

    await assert.rejects(
        () => builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "BUY", amountLamports: 1000000, tokenAddress: TOKEN }),
        /not configured/
    );
    assert.equal(gmgnClient.quoteCallCount(), 0);
});

test("rejects a missing tokenAddress before any GMGN call", async () => {
    const gmgnClient = fakeGmgnClient();
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    await assert.rejects(
        () => builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "BUY", amountLamports: 1000000, tokenAddress: null }),
        /tokenAddress is required/
    );
    assert.equal(gmgnClient.quoteCallCount(), 0);
});

test("rejects an unsupported action before any GMGN call", async () => {
    const gmgnClient = fakeGmgnClient();
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    await assert.rejects(
        () => builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "HOLD", amountLamports: 1000000, tokenAddress: TOKEN }),
        /unsupported action "HOLD"/
    );
    assert.equal(gmgnClient.quoteCallCount(), 0);
});

test("BUY quotes SOL -> token; SELL quotes token -> SOL", async () => {
    const gmgnClient = fakeGmgnClient();
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    await builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "BUY", amountLamports: 1000000, tokenAddress: TOKEN });
    assert.equal(gmgnClient.lastQuoteParams().inputToken, SOL_MINT);
    assert.equal(gmgnClient.lastQuoteParams().outputToken, TOKEN);

    await builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "SELL", amountLamports: 500000, tokenAddress: TOKEN });
    assert.equal(gmgnClient.lastQuoteParams().inputToken, TOKEN);
    assert.equal(gmgnClient.lastQuoteParams().outputToken, SOL_MINT);
});

test("an unsafe quote (excessive price impact) is rejected by the Execution Guard - build() never returns", async () => {
    const gmgnClient = fakeGmgnClient({ quoteResponse: realShapedQuote({ tx: { quote: { priceImpactPct: "20", routePlan: [{}] }, raw_tx: {} } }) });
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    await assert.rejects(
        () => builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "BUY", amountLamports: 1000000, tokenAddress: TOKEN }),
        /price impact 20% exceeds/
    );
    assert.equal(gmgnClient.quoteCallCount(), 1);
    assert.equal(gmgnClient.swapCallCount(), 0); // guard rejection must never reach the state-changing call
});

test("build() with a safe quote returns a custodial-execution marker and performs NO irreversible action yet", async () => {
    const gmgnClient = fakeGmgnClient();
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    const result = await builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "BUY", amountLamports: 1000000, tokenAddress: TOKEN });

    assert.equal(result.__custodialExecution, true);
    assert.equal(typeof result.submit, "function");
    assert.equal(gmgnClient.quoteCallCount(), 1);
    assert.equal(gmgnClient.swapCallCount(), 0); // build() alone must never submit
});

test("submit() calls the real, confirmed POST /v1/trade/swap contract and returns the real tx hash", async () => {
    const gmgnClient = fakeGmgnClient({ swapResponse: realShapedSwapResponse({ hash: "SpecificRealSignature999" }) });
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    const result = await builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "BUY", amountLamports: 1000000, tokenAddress: TOKEN });
    const submitResult = await result.submit();

    assert.equal(submitResult.txHash, "SpecificRealSignature999");
    assert.equal(submitResult.orderId, "order-abc-123");
    assert.equal(submitResult.providerStatus, "pending");
    assert.equal(gmgnClient.swapCallCount(), 1);
    assert.equal(gmgnClient.lastSwapParams().fromAddress, FOUNDER_WALLET);
    assert.equal(gmgnClient.lastSwapParams().inputToken, SOL_MINT);
    assert.equal(gmgnClient.lastSwapParams().outputToken, TOKEN);
});

test("submit() throws a clear error if GMGN's response has no transaction hash - never fabricates one", async () => {
    const gmgnClient = fakeGmgnClient({ swapResponse: { order_id: "order-1", status: "failed" } }); // no hash field
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    const result = await builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "BUY", amountLamports: 1000000, tokenAddress: TOKEN });

    await assert.rejects(() => result.submit(), /did not include a transaction hash/);
});
