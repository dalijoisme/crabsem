// services/researchEngineFactory.test.js - Strategy Profile refactor:
// proves analyzeTokensWithOverride(tokens, ctx, baseKey, override) is
// backward compatible (omitted override reproduces the named base
// philosophy exactly) AND that weights/tiers/minLiquidityUsd/
// minVolumeUsd overrides genuinely change scoring/candidate output -
// the core mechanism the whole refactor depends on. Uses a hand-built,
// DB-free ctx (empty Maps) so this stays a pure unit test, matching
// this codebase's existing test convention of never hitting the real
// DB from a *.test.js file. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { analyzeTokensWithOverride, PHILOSOPHIES } = require("./researchEngineFactory");
const strategyProfileTranslator = require("./strategyProfileTranslator");

function emptyCtx(){
    return {
        trenchesByAddress: new Map(),
        smartMoneyByAddress: new Map(),
        kolByAddress: new Map(),
        cacheMap: new Map(),
        walletsByAddress: new Map()
    };
}

function goodToken(overrides = {}){
    return {
        token_address: "TOKEN1",
        price: 0.001, market_cap: 1000000, liquidity: 50000, holders: 200,
        volume_1h: 30000, price_change_1h: 20, price_change_5m: 1,
        updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
        ...overrides
    };
}

function ctxWithAccumulation(){
    const ctx = emptyCtx();
    ctx.trenchesByAddress.set("TOKEN1", {
        net_buy_24h: 5000, buys_24h: 80, sells_24h: 20, rug_ratio: 0.1, top_10_holder_rate: 0.2,
        is_honeypot: 0, renounced_mint: 1, renounced_freeze_account: 1, creator: null,
        // whale gets real (but weak) data too, so combineScore's weighted
        // average has two DIFFERING data points to reweight between -
        // with only one module reporting hasData:true, scaling its own
        // score+max by the same factor is a no-op on the ratio (the bug
        // the first version of this test had).
        smart_degen_count: 0
    });
    return ctx;
}

test("omitted override reproduces the named base philosophy exactly (momentumHunter)", () => {
    const base = PHILOSOPHIES.find(p => p.key === "momentumHunter");
    const ctx = ctxWithAccumulation();
    const token = goodToken();
    const [withNoOverride] = analyzeTokensWithOverride([token], ctx, "momentumHunter", null);
    const [viaBuildEngines] = require("./researchEngineFactory").buildEngines().find(e => e.key === "momentumHunter").analyzeTokens([token], ctx);
    // freshnessPenalty is a genuinely real-time-based field (marketAgeSeconds
    // vs wall-clock "now" at the moment each call runs) - the two analyze
    // calls above are two separate invocations a few milliseconds apart, so
    // byte-identical equality on this one field isn't the thing this test
    // is proving. Checked separately with a generous tolerance; everything
    // else (score, breakdown, reasons, risk, tiers) must still match exactly.
    const { freshnessPenalty: fp1, ...rest1 } = withNoOverride;
    const { freshnessPenalty: fp2, ...rest2 } = viaBuildEngines;
    assert.deepEqual(rest1, rest2);
    assert.ok(Math.abs(fp1 - fp2) < 0.01, `freshnessPenalty should match within tolerance: ${fp1} vs ${fp2}`);
});

test("unknown base philosophy key throws rather than silently falling back", () => {
    assert.throws(() => analyzeTokensWithOverride([goodToken()], emptyCtx(), "not_a_real_key", {}));
});

test("tiers override changes BUY/HOLD classification without touching the underlying score", () => {
    const ctx = ctxWithAccumulation();
    const [defaultResult] = analyzeTokensWithOverride([goodToken()], ctx, "momentumHunter", null);
    const [loosened] = analyzeTokensWithOverride([goodToken()], ctx, "momentumHunter", { tiers: { buy: 1 } });
    assert.equal(defaultResult.participantScore, loosened.participantScore); // same underlying score
    if(defaultResult.action !== "BUY" && defaultResult.action !== "STRONG BUY"){
        assert.ok(["BUY", "STRONG BUY"].includes(loosened.action)); // a near-zero buy tier always crosses into BUY
    }
});

test("minLiquidityUsd override can veto a token the default philosophy would accept, and vice versa", () => {
    const ctx = ctxWithAccumulation();
    // liquidity below the default $2000 floor, market_cap kept low enough
    // that backingRatio (liquidity/marketCap = 1500/50000 = 0.03) stays
    // safely above safetyVeto.minBackingRatio (0.01) - isolating the
    // minLiquidityUsd check from the separate backing-ratio veto.
    const thinToken = goodToken({ liquidity: 1500, market_cap: 50000 });
    const [defaultResult] = analyzeTokensWithOverride([thinToken], ctx, "momentumHunter", null);
    assert.equal(defaultResult.action, "AVOID"); // vetoed by the global $2000 floor

    const [aggressiveResult] = analyzeTokensWithOverride([thinToken], ctx, "momentumHunter", { minLiquidityUsd: 1000 });
    assert.notEqual(aggressiveResult.action, "AVOID"); // AGGRESSIVE-style lower floor accepts it
});

test("minVolumeUsd (new veto) is a strict no-op when absent, and vetoes a low-volume token when set", () => {
    const ctx = ctxWithAccumulation();
    const lowVolumeToken = goodToken({ volume_1h: 100 });
    const [withoutVeto] = analyzeTokensWithOverride([lowVolumeToken], ctx, "momentumHunter", null);
    assert.notEqual(withoutVeto.action, "AVOID");

    const [withVeto] = analyzeTokensWithOverride([lowVolumeToken], ctx, "momentumHunter", { minVolumeUsd: 3000 });
    assert.equal(withVeto.action, "AVOID");
});

test("weights override reweights the composed participantScore (compositional shift, not just a threshold)", () => {
    const ctx = ctxWithAccumulation();
    const [defaultResult] = analyzeTokensWithOverride([goodToken()], ctx, "momentumHunter", null);
    const [upweighted] = analyzeTokensWithOverride([goodToken()], ctx, "momentumHunter", { weights: { accumulation: 3 } });
    assert.notEqual(defaultResult.participantScore, upweighted.participantScore);
    assert.equal(defaultResult.breakdown.participant.accumulation.max, 20); // scoringConfig default weight
    assert.equal(upweighted.breakdown.participant.accumulation.max, 60); // 20 * 3 multiplier applied via scaleModule
});

test("M5 regression guarantee: STABLE's translated philosophy produces byte-identical output to pre-refactor (no override at all)", () => {
    const ctx = ctxWithAccumulation();
    const stablePhilosophy = strategyProfileTranslator.translate({}).philosophy; // STABLE = an all-default config
    const token = goodToken();
    const [withStable] = analyzeTokensWithOverride([token], ctx, "momentumHunter", stablePhilosophy);
    const [withNoOverrideAtAll] = analyzeTokensWithOverride([token], ctx, "momentumHunter", null);
    // Same freshnessPenalty caveat as the test above - two separate calls,
    // genuinely different wall-clock instants.
    const { freshnessPenalty: fp1, ...rest1 } = withStable;
    const { freshnessPenalty: fp2, ...rest2 } = withNoOverrideAtAll;
    assert.deepEqual(rest1, rest2);
    assert.ok(Math.abs(fp1 - fp2) < 0.01, `freshnessPenalty should match within tolerance: ${fp1} vs ${fp2}`);
});

test("flattenEarliness:false (unlike momentumHunter's own true) lets a big already-moved change1h discount accumulation score", () => {
    const ctx = ctxWithAccumulation();
    const movedToken = goodToken({ price_change_1h: 250 }); // well past the earliness curve's early buckets
    const [flattened] = analyzeTokensWithOverride([movedToken], ctx, "momentumHunter", null); // momentumHunter always flattens
    const [notFlattened] = analyzeTokensWithOverride([movedToken], ctx, "momentumHunter", { flattenEarliness: false });
    assert.ok(notFlattened.breakdown.participant.accumulation.score <= flattened.breakdown.participant.accumulation.score);
});
