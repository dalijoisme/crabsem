// services/execution/transactionBalanceReader.test.js - Arjuna V4
// (Sprint 11), Part 1. Proves the real pre/post SOL+token balance-delta
// extraction against hand-built parsed-transaction shapes (the same
// shape @solana/web3.js's getParsedTransaction returns) - never against
// a live RPC endpoint. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createTransactionBalanceReader } = require("./transactionBalanceReader");

const WALLET = "WalletAddress11111111111111111111111111111";
const MINT = "TokenMintAddress1111111111111111111111111";

function fakeConnectionProvider(parsedTx){
    return { getConnection: () => ({ async getParsedTransaction(){ return parsedTx; } }) };
}

function buildParsedTx({ accountKeys, preBalances, postBalances, preTokenBalances = [], postTokenBalances = [], blockTime = 1785000000, slot = 42 }){
    return {
        blockTime, slot,
        transaction: { message: { accountKeys: accountKeys.map(k => ({ pubkey: { toString: () => k } })) } },
        meta: { preBalances, postBalances, preTokenBalances, postTokenBalances }
    };
}

test("a BUY: real negative SOL delta (spent) and positive token delta (received)", async () => {
    const parsedTx = buildParsedTx({
        accountKeys: [WALLET, "OtherAccount"],
        preBalances: [1_000_000_000, 0],
        postBalances: [965_186_000, 0], // spent 0.034814 SOL (+ fee, folded in)
        postTokenBalances: [{ owner: WALLET, mint: MINT, uiTokenAmount: { uiAmount: 1000000 } }]
    });
    const reader = createTransactionBalanceReader(fakeConnectionProvider(parsedTx));
    const result = await reader.readActualSwapAmounts("sig-buy", WALLET, MINT);

    assert.equal(result.solDeltaLamports, -34_814_000);
    assert.equal(result.tokenDeltaUi, 1000000);
    assert.equal(result.blockTime, 1785000000);
});

test("a SELL: real positive SOL delta (received) and negative token delta (spent)", async () => {
    const parsedTx = buildParsedTx({
        accountKeys: [WALLET, "OtherAccount"],
        preBalances: [965_186_000, 0],
        postBalances: [1_000_000_000, 0], // received 0.034814 SOL
        preTokenBalances: [{ owner: WALLET, mint: MINT, uiTokenAmount: { uiAmount: 1000000 } }],
        postTokenBalances: [] // full sell - token account closed, no post entry
    });
    const reader = createTransactionBalanceReader(fakeConnectionProvider(parsedTx));
    const result = await reader.readActualSwapAmounts("sig-sell", WALLET, MINT);

    assert.equal(result.solDeltaLamports, 34_814_000);
    assert.equal(result.tokenDeltaUi, -1000000); // 0 (post) - 1000000 (pre)
});

test("returns null when the transaction/meta can't be found - never fabricates a delta", async () => {
    const reader = createTransactionBalanceReader(fakeConnectionProvider(null));
    const result = await reader.readActualSwapAmounts("sig-missing", WALLET, MINT);
    assert.equal(result, null);
});

test("wallet not present in accountKeys: solDeltaLamports is null, never guessed", async () => {
    const parsedTx = buildParsedTx({
        accountKeys: ["SomeOtherWallet"],
        preBalances: [1000],
        postBalances: [900]
    });
    const reader = createTransactionBalanceReader(fakeConnectionProvider(parsedTx));
    const result = await reader.readActualSwapAmounts("sig-x", WALLET, MINT);
    assert.equal(result.solDeltaLamports, null);
});

test("tokenMint omitted: skips the token-balance read entirely, only reports the real SOL delta", async () => {
    const parsedTx = buildParsedTx({
        accountKeys: [WALLET],
        preBalances: [1_000_000_000],
        postBalances: [965_186_000]
    });
    const reader = createTransactionBalanceReader(fakeConnectionProvider(parsedTx));
    const result = await reader.readActualSwapAmounts("sig-nomint", WALLET, null);
    assert.equal(result.solDeltaLamports, -34_814_000);
    assert.equal(result.tokenDeltaUi, null);
});
