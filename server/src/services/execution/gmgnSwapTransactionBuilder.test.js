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

// Execution Safety Project: a SELL whose first (tier 1, 15%) quote
// exceeds tier 1's own real ceiling escalates exactly once to tier 2
// (50%, the same tolerance every SELL used unconditionally before this
// project) and accepts there - never blocked by an entry-oriented risk
// ceiling, but no longer unconditionally accepting the FIRST quote
// either. Route-hop count is still never a reason to block a SELL.
test("a SELL exceeding tier 1's real ceiling escalates exactly once to tier 2 and accepts there - never blocked, but no longer accepting the first quote unconditionally", async () => {
    const gmgnClient = fakeGmgnClient({
        quoteResponse: realShapedQuote({
            slippage: 40,
            tx: { quote: { priceImpactPct: "35", routePlan: [{}, {}, {}, {}, {}] }, raw_tx: {} }
        })
    });
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    const result = await builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "SELL", amountLamports: 500000, tokenAddress: TOKEN });

    assert.equal(result.__custodialExecution, true, "35% price impact clears tier 2's 50% ceiling, so this SELL must still build successfully");
    assert.equal(gmgnClient.quoteCallCount(), 2, "tier 1 must be tried and rejected before tier 2 is attempted - not accepted on the first quote");
    assert.equal(gmgnClient.lastQuoteParams().slippage, 50, "the accepted attempt was tier 2's wider tolerance");
});

// A quote so far outside the market that even tier 2 (50%) rejects it
// must still never permanently block the exit (Incident A) - falls
// through to unconditional acceptance, bounded to exactly the two real
// tiers first (never a 3rd, unbounded retry).
test("a SELL exceeding even tier 2 falls through to unconditional acceptance after exactly two real tiers - Incident A never regresses", async () => {
    const gmgnClient = fakeGmgnClient({
        quoteResponse: realShapedQuote({
            slippage: 90,
            tx: { quote: { priceImpactPct: "90", routePlan: [{}] }, raw_tx: {} }
        })
    });
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    const result = await builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "SELL", amountLamports: 500000, tokenAddress: TOKEN });

    assert.equal(result.__custodialExecution, true, "even a catastrophic 90% price impact must still build - a completed exit beats a permanently blocked one");
    assert.equal(gmgnClient.quoteCallCount(), 2, "exactly two real tiers, never an unbounded retry loop");
});

// The common case - the vast majority of real exits shouldn't need
// anything close to the old unconditional tolerance. Tier 1 alone must
// be sufficient, with no wasted second quote fetch.
test("a SELL within tier 1's real ceiling accepts on the first attempt - no escalation, no wasted quote fetch", async () => {
    const gmgnClient = fakeGmgnClient(); // default: priceImpactPct "0", well within tier 1
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    const result = await builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "SELL", amountLamports: 500000, tokenAddress: TOKEN });

    assert.equal(result.__custodialExecution, true);
    assert.equal(gmgnClient.quoteCallCount(), 1, "tier 1 alone must be enough for an ordinary quote");
    assert.equal(gmgnClient.lastQuoteParams().slippage, 15, "tier 1's own, real, protective tolerance - not the old unconditional 50%");
    assert.equal(result.executionTier, "TIER_1", "Release Validation, checklist item 6/7: which real tier resolved this SELL must be observable");
});

// Release Validation, checklist item 6/7 - executionTier must correctly
// report TIER_2 and FALLBACK too (not just the common TIER_1 case), and
// must be null for BUY (never tiered).
test("executionTier reports TIER_2 when tier 1 is exceeded but tier 2 accepts", async () => {
    const gmgnClient = fakeGmgnClient({
        quoteResponse: realShapedQuote({ slippage: 40, tx: { quote: { priceImpactPct: "35", routePlan: [{}] }, raw_tx: {} } })
    });
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });
    const result = await builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "SELL", amountLamports: 500000, tokenAddress: TOKEN });
    assert.equal(result.executionTier, "TIER_2");
});

test("executionTier reports FALLBACK when both real tiers are exceeded", async () => {
    const gmgnClient = fakeGmgnClient({
        quoteResponse: realShapedQuote({ slippage: 90, tx: { quote: { priceImpactPct: "90", routePlan: [{}] }, raw_tx: {} } })
    });
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });
    const result = await builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "SELL", amountLamports: 500000, tokenAddress: TOKEN });
    assert.equal(result.executionTier, "FALLBACK");
});

test("executionTier is null for BUY - never tiered", async () => {
    const gmgnClient = fakeGmgnClient();
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });
    const result = await builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "BUY", amountLamports: 1000000, tokenAddress: TOKEN });
    assert.equal(result.executionTier, null);
});

// The exact same shape rejected for BUY (line above) must still be
// rejected for BUY after this fix - only SELL's risk tolerance changed.
test("a BUY with excessive price impact is still rejected by the Execution Guard - the fix is SELL-only, BUY's entry risk posture is untouched", async () => {
    const gmgnClient = fakeGmgnClient({ quoteResponse: realShapedQuote({ tx: { quote: { priceImpactPct: "20", routePlan: [{}] }, raw_tx: {} } }) });
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    await assert.rejects(
        () => builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "BUY", amountLamports: 1000000, tokenAddress: TOKEN }),
        /price impact 20% exceeds/
    );
});

// A SELL still can't execute against a quote that is genuinely
// impossible to submit (no route, non-positive output) - bypassing the
// risk-TOLERANCE ceilings must never bypass the hard sanity checks too.
test("a SELL quote with literally no route is still rejected - the hard sanity check is unconditional, only the risk-tolerance ceilings are bypassed", async () => {
    const gmgnClient = fakeGmgnClient({ quoteResponse: realShapedQuote({ tx: { quote: { priceImpactPct: "0", routePlan: [] }, raw_tx: {} } }) });
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    await assert.rejects(
        () => builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "SELL", amountLamports: 500000, tokenAddress: TOKEN }),
        /quote returned no route/
    );
});

// BUY's own tolerance (10%, unchanged) is untouched by the Execution
// Safety Project. SELL's requested tolerance now depends on which real
// tier accepted the quote - see the tier-specific tests above for the
// 15%-first/50%-escalated/unconditional-fallback cases.
test("BUY keeps the existing 10% default slippage request, untouched by the Execution Safety Project", async () => {
    const gmgnClient = fakeGmgnClient();
    const builder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

    await builder.build({ userId: 1, walletPublicKey: FOUNDER_WALLET, action: "BUY", amountLamports: 1000000, tokenAddress: TOKEN });
    assert.equal(gmgnClient.lastQuoteParams().slippage, 10);
    assert.equal(gmgnClient.quoteCallCount(), 1, "BUY is never tiered - one quote, one check");
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
