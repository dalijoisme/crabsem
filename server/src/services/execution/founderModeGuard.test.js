// services/execution/founderModeGuard.test.js - proves the guard fails
// closed when unconfigured (never "open by omission"), accepts only an
// exact match, and rejects everything else including near-misses.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { assertFounderWallet } = require("./founderModeGuard");

test("rejects every wallet when FOUNDER_WALLET_PUBLIC_KEY is not configured (fails closed)", () => {
    assert.throws(
        () => assertFounderWallet({ FOUNDER_WALLET_PUBLIC_KEY: null }, "AnyWalletAddressAtAll"),
        /not configured/
    );
});

test("accepts an exact match", () => {
    assert.doesNotThrow(() => assertFounderWallet({ FOUNDER_WALLET_PUBLIC_KEY: "FounderWallet111" }, "FounderWallet111"));
});

test("rejects a near-miss (case/whitespace differences are not fuzzy-matched)", () => {
    const config = { FOUNDER_WALLET_PUBLIC_KEY: "FounderWallet111" };
    assert.throws(() => assertFounderWallet(config, "founderwallet111"), /not the configured Founder Trading Wallet/);
    assert.throws(() => assertFounderWallet(config, "FounderWallet111 "), /not the configured Founder Trading Wallet/);
});

test("rejects an empty string wallet even when configured", () => {
    assert.throws(() => assertFounderWallet({ FOUNDER_WALLET_PUBLIC_KEY: "FounderWallet111" }, ""), /not the configured Founder Trading Wallet/);
});
