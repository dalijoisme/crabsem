// utils/explorerUrl.test.js - pure function, no I/O. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSolanaTxUrl } = require("./explorerUrl");

test("buildSolanaTxUrl returns null for a missing hash - never a fabricated link", () => {
    assert.equal(buildSolanaTxUrl(null), null);
    assert.equal(buildSolanaTxUrl(undefined), null);
    assert.equal(buildSolanaTxUrl(""), null);
});

test("buildSolanaTxUrl builds a plain mainnet-beta link with no cluster query string", () => {
    assert.equal(buildSolanaTxUrl("abc123", "mainnet-beta"), "https://explorer.solana.com/tx/abc123");
});

test("buildSolanaTxUrl defaults to mainnet-beta when no cluster is given", () => {
    assert.equal(buildSolanaTxUrl("abc123"), "https://explorer.solana.com/tx/abc123");
});

test("buildSolanaTxUrl appends ?cluster= for a non-mainnet cluster", () => {
    assert.equal(buildSolanaTxUrl("abc123", "devnet"), "https://explorer.solana.com/tx/abc123?cluster=devnet");
});
