// services/featureNormalizer.test.js - Decision Engine V2 sprint. Proves
// the SAME normalization the AI Performance Audit script's Section A/B
// already relies on, now shared so the live Decision Engine V2 and the
// offline audit can never silently disagree on "is this the same
// feature". Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeFeature, normalizeFeatureList, comboKey, getCombinationKeys } = require("./featureNormalizer");

test("normalizeFeature strips dollar amounts inside parentheses", () => {
    assert.equal(normalizeFeature("Net accumulation detected ($3,121 net buys,24h)"), "Net accumulation detected");
    assert.equal(normalizeFeature("Smart money accumulation detected ($582 bought...)"), "Smart money accumulation detected");
});

test("normalizeFeature strips embedded percentages and bare counts", () => {
    assert.equal(normalizeFeature("Snipers hold 31% of top holdings"), "Snipers hold of top holdings");
    assert.equal(normalizeFeature("3 smart/degen wallets present"), "smart/degen wallets present");
    assert.equal(normalizeFeature("Very few holders (18) - concentration risk"), "Very few holders - concentration risk");
});

test("normalizeFeature leaves an already-categorical string unchanged", () => {
    assert.equal(normalizeFeature("No sniper-bot activity detected"), "No sniper-bot activity detected");
});

test("normalizeFeatureList deduplicates after normalization", () => {
    const result = normalizeFeatureList([
        "Net accumulation detected ($1,332 net buys, 24h)",
        "Net accumulation detected ($3,025 net buys, 24h)"
    ]);
    assert.deepEqual(result, ["Net accumulation detected"]);
});

test("normalizeFeatureList returns [] for a non-array input, never throws", () => {
    assert.deepEqual(normalizeFeatureList(null), []);
    assert.deepEqual(normalizeFeatureList(undefined), []);
});

test("comboKey sorts so combination order never affects the key", () => {
    assert.equal(comboKey(["B", "A"]), comboKey(["A", "B"]));
    assert.equal(comboKey(["A", "B"]), "A + B");
});

test("getCombinationKeys returns size 1 and 2 combos for a 2-feature list, pair first", () => {
    const keys = getCombinationKeys(["A", "B"], 3);
    assert.equal(keys[0], "A + B");
    assert.ok(keys.includes("A"));
    assert.ok(keys.includes("B"));
    assert.equal(keys.length, 3);
});

test("getCombinationKeys caps at maxSize - a 3-feature list with maxSize=2 never returns the triplet", () => {
    const keys = getCombinationKeys(["A", "B", "C"], 2);
    assert.ok(!keys.includes("A + B + C"));
    assert.equal(keys.length, 6); // 3 pairs + 3 singles
});

test("getCombinationKeys orders largest-combination-first for a 3-feature list", () => {
    const keys = getCombinationKeys(["A", "B", "C"], 3);
    assert.equal(keys[0], "A + B + C");
    assert.equal(keys.length, 7); // 1 triplet + 3 pairs + 3 singles
});

test("getCombinationKeys on a single-feature list returns just that feature", () => {
    assert.deepEqual(getCombinationKeys(["A"], 3), ["A"]);
});
