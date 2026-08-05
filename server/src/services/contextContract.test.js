// services/contextContract.test.js - Sprint 15, Phase 1. DB-free unit
// tests (this codebase's existing convention - see
// researchEngineFactory.test.js's own header) proving assertValidContext
// enforces exactly the Context Contract: a missing top-level container
// throws, named; a missing/empty entry inside a present container never
// throws.

const test = require("node:test");
const assert = require("node:assert/strict");

const { CURRENT_CONTEXT_SCHEMA, CONTEXT_SCHEMA_VERSION, assertValidContext } = require("./contextContract");

// Mirrors researchEngineFactory.preloadContext(tokens)'s real return
// shape exactly (all 7 keys) - not the narrower emptyCtx() helper
// researchEngineFactory.test.js uses today, which only sets the 5 keys
// analyzeTokenWithPhilosophy actually reads. This one intentionally
// includes all 7, since assertValidContext's job is to check the
// BUILDER's full contract, not just what one particular scoring path
// happens to consume.
function fullRealisticContext(){
    return {
        trenchesByAddress: new Map(),
        hotSearchByAddress: new Map(),
        smartMoneyByAddress: new Map(),
        kolByAddress: new Map(),
        cacheMap: new Map(),
        walletsByAddress: new Map(),
        launchpadStatsByName: new Map(),
        // Sprint 15, Phase 2 additions.
        peakPriceByAddress: new Map(),
        liquidityAtWindowStartByAddress: new Map(),
        realtimePulseByAddress: new Map()
    };
}

test("a ctx with every required container present passes, even when every container is empty", () => {
    assert.doesNotThrow(() => assertValidContext(fullRealisticContext(), "preloadContext"));
});

test("a ctx with a real entry present inside a container still passes (never inspects entries)", () => {
    const ctx = fullRealisticContext();
    ctx.trenchesByAddress.set("TOKEN1", { net_buy_24h: 5000 });
    assert.doesNotThrow(() => assertValidContext(ctx, "preloadContext"));
});

for(const key of CURRENT_CONTEXT_SCHEMA){

    test(`a ctx missing top-level container '${key}' throws a CONTEXT_CONTRACT_VIOLATION naming it`, () => {
        const ctx = fullRealisticContext();
        delete ctx[key];
        assert.throws(
            () => assertValidContext(ctx, "preloadContext"),
            (err) => err.message.includes("CONTEXT_CONTRACT_VIOLATION") && err.message.includes(key)
        );
    });

}

test("a completely missing ctx object throws, naming the source", () => {
    assert.throws(
        () => assertValidContext(undefined, "preloadContext"),
        (err) => err.message.includes("CONTEXT_CONTRACT_VIOLATION") && err.message.includes("preloadContext")
    );
});

test("a token missing entirely from a container (no row at all) is legitimate business data, not a violation", () => {
    // Same real case as ~24% of tracked tokens having no gmgn_trenches
    // row (entryGateService.js's own MISSING_QUALITY_DATA comment) -
    // trenchesByAddress.get(address) returning undefined for a specific
    // token must never be conflated with the container itself being
    // absent.
    const ctx = fullRealisticContext();
    assert.equal(ctx.trenchesByAddress.get("SOME_TOKEN_NEVER_SEEN"), undefined);
    assert.doesNotThrow(() => assertValidContext(ctx, "preloadContext"));
});

test("requiredContainers is overridable, so Phase 2+ schema growth never has to touch this file's own defaults", () => {
    const ctx = { onlyThisOne: new Map() };
    assert.doesNotThrow(() => assertValidContext(ctx, "futureBuilder", ["onlyThisOne"]));
    assert.throws(() => assertValidContext(ctx, "futureBuilder", ["onlyThisOne", "somethingElse"]));
});

test("a violation names the schema version even when no engineVersion is supplied", () => {
    const ctx = fullRealisticContext();
    delete ctx.cacheMap;
    assert.throws(
        () => assertValidContext(ctx, "preloadContext"),
        (err) => err.message.includes(`contextSchemaVersion=${CONTEXT_SCHEMA_VERSION}`) && !err.message.includes("engineVersion=")
    );
});

test("a violation includes engineVersion when the caller supplies it via meta", () => {
    const ctx = fullRealisticContext();
    delete ctx.cacheMap;
    assert.throws(
        () => assertValidContext(ctx, "preloadContext", CURRENT_CONTEXT_SCHEMA, { engineVersion: "production_v2" }),
        (err) => err.message.includes("engineVersion=production_v2")
    );
});

test("a violation on a missing ctx object also carries source and schema version", () => {
    assert.throws(
        () => assertValidContext(undefined, "preloadContext", CURRENT_CONTEXT_SCHEMA, { engineVersion: "production_v2" }),
        (err) => err.message.includes("source=preloadContext") && err.message.includes(`contextSchemaVersion=${CONTEXT_SCHEMA_VERSION}`) && err.message.includes("engineVersion=production_v2")
    );
});
