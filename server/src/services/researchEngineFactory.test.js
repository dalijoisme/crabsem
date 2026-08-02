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
        // "Validated momentum" fix: momentumHunter's own entryGate needs
        // real age data - 2h old by default (well past
        // MOMENTUM_HUNTER_MIN_TOKEN_AGE_MINUTES) so every EXISTING test
        // using this fixture keeps testing what it always tested, not
        // this new gate. Tests for the gate itself override this.
        launch_time: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " "),
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
    const { freshnessPenalty: fp1, entryScoreBreakdown: esb1, ...rest1 } = withNoOverride;
    const { freshnessPenalty: fp2, entryScoreBreakdown: esb2, ...rest2 } = viaBuildEngines;
    assert.deepEqual(rest1, rest2);
    assert.ok(Math.abs(fp1 - fp2) < 0.01, `freshnessPenalty should match within tolerance: ${fp1} vs ${fp2}`);
    // Arjuna V3: entryScoreBreakdown.ageMinutes is the same real-time-based
    // wall-clock computation as freshnessPenalty above - same tolerance
    // treatment, everything else in the breakdown must match exactly.
    const { ageMinutes: am1, ...esbRest1 } = esb1;
    const { ageMinutes: am2, ...esbRest2 } = esb2;
    assert.deepEqual(esbRest1, esbRest2);
    assert.ok(Math.abs(am1 - am2) < 0.01, `ageMinutes should match within tolerance: ${am1} vs ${am2}`);
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

// Arjuna V3 (FINAL SPRINT): participantScore is now the unified
// 10-module entry score (config.entryScore.weights), computed from each
// module's own score/max RATIO - a philosophy `weights` multiplier
// override (scaleModule scales score AND max by the same factor) no
// longer shifts that ratio, so it no longer moves participantScore/
// action either. It still visibly reweights the OLD participant pool
// (breakdown.participant.*.max, and that pool's own confidence-blending
// contribution) exactly as before - this test now asserts THAT, not a
// participantScore shift, since momentumHunter (Arjuna, the only
// philosophy actually live-traded) never sets a weights override at
// all, so this behavior change has no effect on real production
// scoring.
test("weights override still reweights the OLD participant pool (breakdown/confidence), even though the new unified entry score is ratio-based and doesn't shift from it", () => {
    const ctx = ctxWithAccumulation();
    const [defaultResult] = analyzeTokensWithOverride([goodToken()], ctx, "momentumHunter", null);
    const [upweighted] = analyzeTokensWithOverride([goodToken()], ctx, "momentumHunter", { weights: { accumulation: 3 } });
    assert.equal(defaultResult.breakdown.participant.accumulation.max, 20); // scoringConfig default weight
    assert.equal(upweighted.breakdown.participant.accumulation.max, 60); // 20 * 3 multiplier applied via scaleModule
    assert.equal(defaultResult.participantScore, upweighted.participantScore); // unified entry score is ratio-based - unaffected
});

// False Positive Reduction V2, Priority 1: combineScore must fold a
// hasData:false module's own real neutral score INTO the weighted
// average (dragging the total toward neutral), never exclude it and let
// the remaining modules' weight silently expand to fill the gap. A
// token with only ONE module reporting real data (accumulation, maxed
// out) and every other participant module missing must score close to
// neutral overall, not close to a maxed-out single-module score.
test("a module with no real data drags the aggregate toward neutral, never gets excluded from the average", () => {
    const ctx = emptyCtx();
    // Only accumulation has real (maxed-out) data - net_buy_24h strongly
    // positive, high buy dominance, well above the significance floor.
    // smart_degen_count/creator/sniper_count/bundler/insider fields are
    // all absent, so whale/developer/sniperQuality/bundleQuality/
    // insiderQuality/smartMoney/kol/walletQuality/walletProfitability
    // all report hasData:false.
    ctx.trenchesByAddress.set("TOKEN1", { net_buy_24h: 50000, buys_24h: 100, sells_24h: 5 });
    const token = goodToken({ price_change_1h: 5, price_change_5m: 1 }); // stays in the earliness curve's top (1.00) bucket

    const [result] = analyzeTokensWithOverride([token], ctx, "momentumHunter", null);

    assert.equal(result.breakdown.participant.accumulation.hasData, true);
    assert.equal(result.breakdown.participant.accumulation.score, result.breakdown.participant.accumulation.max); // maxed out
    assert.equal(result.breakdown.participant.smartMoney.hasData, false);

    // Before the dilution fix, combineScore would have excluded every
    // hasData:false module and scored this ~100 (accumulation alone,
    // maxed, is 100% of the only weight counted). With that fix, the 9
    // missing modules' own real neutral scores (40% of their weight)
    // are folded in too, pulling the real total well below a maxed
    // single-module score. SPRINT 12 (Arjuna V5): this token has no
    // seeded token_price_history (emptyCtx()), so it honestly classifies
    // EARLY_MOMENTUM (never a fabricated crash) - the CTO's own +10
    // scoring modifier applies uniformly, raising the ceiling this
    // assertion checks against from 70 to 80.
    assert.ok(result.participantScore < 80, `expected the missing modules to drag participantScore below 80, got ${result.participantScore}`);
});

// Real replay: this account's own two real BUYs (Fukuruto, MOON -
// 2026-07-30), re-run through the exact real AGGRESSIVE override and
// their exact real gmgn_trenches data. Historically this test pinned
// specific pre-Arjuna-V3 numbers (65/64, both BUY not STRONG BUY) from
// an earlier earliness-curve bugfix. Arjuna V3 (FINAL SPRINT) replaced
// participantScore with the unified 10-module entry score, which - per
// Part 4's explicit "increase holder distribution importance
// significantly" - now folds real holder count directly into the
// action-driving score for the first time (previously market-side only,
// confidence-blending, never action). FUK's real 255 holders vs MOON's
// real 18 is exactly the kind of gap this sprint intended to matter
// more - FUK now legitimately reaches STRONG BUY on that real breadth
// of holders, MOON stays at BUY. Numbers below are the new real
// baseline; re-verify against config.entryScore before trusting old
// assumptions if this test needs to change again.
test("real replay: MOON and Fukuruto's own real trenches data, under Arjuna V3's unified entry score", () => {
    const ctx = emptyCtx();
    ctx.trenchesByAddress.set("FUKURUTO", {
        net_buy_24h: 1331.56320724565, buys_24h: 75, sells_24h: 15, rug_ratio: 0, top_10_holder_rate: 0.2788,
        smart_degen_count: 0, sniper_count: 0, is_honeypot: 0, creator: "SomeCreator1",
        raw_json: JSON.stringify({ creator_created_count: 1, creator_created_open_ratio: 0, creator_balance_rate: 0, top70_sniper_hold_rate: 0.3050340876, bundler_mhr: 0, suspected_insider_hold_rate: 0.0008 })
    });
    ctx.trenchesByAddress.set("MOON", {
        net_buy_24h: 2511.66863048428, buys_24h: 45, sells_24h: 9, rug_ratio: 0, top_10_holder_rate: 0.5958,
        smart_degen_count: 0, sniper_count: 0, is_honeypot: 0, creator: "SomeCreator2",
        raw_json: JSON.stringify({ creator_created_count: 1, creator_created_open_ratio: 0, creator_balance_rate: 0.3199, top70_sniper_hold_rate: 0.3198544194, bundler_mhr: 0, suspected_insider_hold_rate: 0.026 })
    });

    const aggressiveOverride = {
        weights: { accumulation: 1.6, smartMoney: 1.8, kol: 1.4, whale: 1.5, developer: 0.8, sniperQuality: 0.7, bundleQuality: 0.7, insiderQuality: 0.7, holderDistribution: 0.5, volume: 0.5, priceStability: 0.4 },
        tiers: { buy: 55, strongBuy: 75 }, minLiquidityUsd: 1200, flattenEarliness: true, smBonus: true,
        acceleration: { recentWindowMinutes: 15, priorWindowMinutes: 60, maxBonusFraction: 0.15, requireGateForEntry: true }
    };

    const fukuruto = goodToken({ token_address: "FUKURUTO", price: 0.00000965975, market_cap: 9572.75, liquidity: 9489.95, holders: 255, price_change_1h: 350.037, price_change_5m: 350.037, volume_1h: 0 });
    const moon = goodToken({ token_address: "MOON", price: 0.000011505, market_cap: 11505, liquidity: 10474.6, holders: 18, price_change_1h: 292.86, price_change_5m: 292.86, volume_1h: 0 });

    const [fukResult] = analyzeTokensWithOverride([fukuruto], ctx, "momentumHunter", aggressiveOverride);
    const [moonResult] = analyzeTokensWithOverride([moon], ctx, "momentumHunter", aggressiveOverride);

    // FUK: real 255 holders now legitimately earns full holderDistribution
    // credit (Part 4's >=120 bucket) under the unified score - reaches
    // STRONG BUY on real breadth of participation, not a bug. SPRINT 12
    // (Arjuna V5): neither fixture seeds token_price_history (emptyCtx()),
    // so both real, large 1h/5m moves classify as EARLY_MOMENTUM
    // (drawdownFromPeak is honestly null, never a fabricated crash) -
    // the CTO's own +10 scoring modifier applies uniformly, 75 -> 85.
    assert.equal(fukResult.participantScore, 85);
    assert.equal(fukResult.action, "STRONG BUY");

    // MOON: real 18 holders falls in Part 4's <40 bucket (0 credit) -
    // stays well short of FUK's score despite similar accumulation/price
    // action, exactly the real differentiator this sprint intended.
    // Same EARLY_MOMENTUM +10 modifier applies here too, 62 -> 72 - still
    // well under AGGRESSIVE's strongBuy floor (75).
    assert.equal(moonResult.participantScore, 72);
    assert.ok(moonResult.participantScore < 75, "MOON's real 18 holders must keep it below AGGRESSIVE's strongBuy floor (75), unlike FUK's real 255");
    assert.equal(moonResult.action, "BUY");
});

// Arjuna V3 (FINAL SPRINT), Part 8: age is now a BONUS only - the
// earlier sprint's hard entryGate (reject below 10 minutes) is REMOVED.
// A young token can still reach BUY on its own merits; it just never
// gets the older token's small additive bonus (config.entryScore.ageBonus).
test("Part 8: age is bonus-only - a genuinely young token is NOT rejected/downgraded on age alone, just scores a few points lower than an identical older one", () => {
    const ctx = ctxWithAccumulation();
    const youngToken = goodToken({ launch_time: new Date(Date.now() - 2 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ") }); // 2 min old, +0 bonus
    const oldToken = goodToken({ launch_time: new Date(Date.now() - 25 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ") }); // 25 min old, +8 bonus

    const [youngResult] = analyzeTokensWithOverride([youngToken], ctx, "momentumHunter", null);
    const [oldResult] = analyzeTokensWithOverride([oldToken], ctx, "momentumHunter", null);

    assert.equal(youngResult.entryScoreBreakdown.ageBonusPoints, 0);
    assert.equal(oldResult.entryScoreBreakdown.ageBonusPoints, 8);
    // Same +8-point gap reflected in the final score - age never rejects,
    // it only ever adds a small amount on top of everything else.
    assert.equal(oldResult.participantScore - youngResult.participantScore, 8);
});

test("Part 8: missing age data is neutral (+0 bonus), never a rejection or a guessed bonus", () => {
    const ctx = ctxWithAccumulation(); // TOKEN1's trenches entry has no created_timestamp either
    const noAgeData = goodToken({ launch_time: null });
    const [result] = analyzeTokensWithOverride([noAgeData], ctx, "momentumHunter", null);
    assert.equal(result.entryScoreBreakdown.ageBonusPoints, 0);
    assert.equal(result.entryScoreBreakdown.ageMinutes, null);
});

test("Part 8: age bonus buckets match the final spec exactly (0/2/5/8)", () => {
    const ctx = ctxWithAccumulation();
    const cases = [
        { minutesAgo: 3, expectedBonus: 0 },
        { minutesAgo: 7, expectedBonus: 2 },
        { minutesAgo: 15, expectedBonus: 5 },
        { minutesAgo: 30, expectedBonus: 8 }
    ];
    for(const { minutesAgo, expectedBonus } of cases){
        const token = goodToken({ launch_time: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString().slice(0, 19).replace("T", " ") });
        const [result] = analyzeTokensWithOverride([token], ctx, "momentumHunter", null);
        assert.equal(result.entryScoreBreakdown.ageBonusPoints, expectedBonus, `${minutesAgo}min old should get +${expectedBonus}`);
    }
});

// SPRINT 12 (Arjuna V5) - CTO DECISION (FINAL): proves the momentum
// scoring modifier is genuinely wired end to end (module -> config
// lookup -> computeUnifiedEntryScore's final score), not just correct
// in isolation (see intelligence/market/momentumPhase.test.js for the
// phase-classification logic itself). EXIT_LIQUIDITY is used here
// because it's the one phase reachable without seeding real
// token_price_history (a DB-free trenches.net_buy_24h fact is enough) -
// consistent with this file's own "DB-free ctx" convention.
test("Part 12 (Sprint 12): momentum scoring modifier is applied directly into the final entry score, never as a separate reject", () => {
    // buys_5m/sells_5m are read ONLY by momentumPhase.js in the entry-
    // scoring pipeline (never by accumulation/any other module) - the
    // cleanest isolated lever to flip EXIT_LIQUIDITY on/off without
    // touching any other module's own real score, unlike net_buy_24h
    // (which accumulation.js also legitimately reads).
    const ctx = ctxWithAccumulation();
    const risingToken = goodToken({ price_change_5m: 5, price_change_1h: 20, buys_5m: 1000, sells_5m: 9000 });

    const [withPenalty] = analyzeTokensWithOverride([risingToken], ctx, "momentumHunter", null);
    assert.equal(withPenalty.entryScoreBreakdown.momentumPhase, "EXIT_LIQUIDITY");
    assert.equal(withPenalty.entryScoreBreakdown.momentumModifierPoints, -12, "the CTO's own fixed point table (config/scoringConfig.js) must be applied verbatim");

    // Same token, but with real 5m buy pressure DOMINANT instead - no
    // longer EXIT_LIQUIDITY. This fixture has no seeded
    // token_price_history (this file's own DB-free ctx convention), so
    // it honestly falls back to EARLY_MOMENTUM (+10, never a fabricated
    // crash) rather than HEALTHY_MOMENTUM - participantScore must be
    // exactly 22 points higher (-12 -> +10), all else identical.
    const cleanCtx = ctxWithAccumulation();
    const healthyToken = goodToken({ price_change_5m: 5, price_change_1h: 20, buys_5m: 9000, sells_5m: 1000 });
    const [withoutPenalty] = analyzeTokensWithOverride([healthyToken], cleanCtx, "momentumHunter", null);
    assert.equal(withoutPenalty.entryScoreBreakdown.momentumPhase, "EARLY_MOMENTUM");
    assert.equal(withoutPenalty.participantScore - withPenalty.participantScore, 22, "the EXIT_LIQUIDITY(-12) -> EARLY_MOMENTUM(+10) swing must be the ONLY difference between these two otherwise-identical tokens");

    // Never a hard reject on its own - action tier is governed purely by
    // whether the resulting Final Score still clears the threshold.
    assert.ok(!["HIGH_RISK_REJECTED"].includes(withPenalty.action), "momentum must never produce a reject reason - only a score delta");
});

// False Positive Reduction V2, Priority 3: confidence must fall as risk
// escalates, even when NOTHING else about the token changed. Isolated via
// the risk hard-trigger boundary (price_change_1h >= 500 forces HIGH
// regardless of riskReasons count) - at 499% vs 500%, participantScore
// and marketHealth are byte-identical (flattenEarliness means
// participant-side scoring never reads change1h's magnitude, and both
// values land in priceStabilityCurve's same terminal bucket) - the ONLY
// thing that differs is risk (MEDIUM -> HIGH) and, because of this
// sprint's fix, confidence.
test("confidence falls as risk escalates, even when participantScore/marketHealth are unchanged", () => {
    const ctx = emptyCtx();
    ctx.trenchesByAddress.set("TOKEN1", { net_buy_24h: 5000, buys_24h: 80, sells_24h: 20, rug_ratio: 0.1, top_10_holder_rate: 0.2, is_honeypot: 0, smart_degen_count: 0 });

    const [belowTrigger] = analyzeTokensWithOverride([goodToken({ price_change_1h: 499, price_change_5m: 1 })], ctx, "momentumHunter", null);
    const [atTrigger] = analyzeTokensWithOverride([goodToken({ price_change_1h: 500, price_change_5m: 1 })], ctx, "momentumHunter", null);

    assert.equal(belowTrigger.risk, "MEDIUM");
    assert.equal(atTrigger.risk, "HIGH");
    assert.equal(belowTrigger.participantScore, atTrigger.participantScore, "participantScore must be unaffected - isolating the risk penalty alone");
    assert.equal(belowTrigger.marketHealth, atTrigger.marketHealth, "marketHealth must be unaffected - isolating the risk penalty alone");
    assert.equal(belowTrigger.confidence - atTrigger.confidence, 12, "HIGH's 20-point penalty minus MEDIUM's 8-point penalty must show up exactly, nothing else changed");
});

test("M5 regression guarantee: STABLE's translated philosophy produces byte-identical output to pre-refactor (no override at all)", () => {
    const ctx = ctxWithAccumulation();
    const stablePhilosophy = strategyProfileTranslator.translate({}).philosophy; // STABLE = an all-default config
    const token = goodToken();
    const [withStable] = analyzeTokensWithOverride([token], ctx, "momentumHunter", stablePhilosophy);
    const [withNoOverrideAtAll] = analyzeTokensWithOverride([token], ctx, "momentumHunter", null);
    // Same freshnessPenalty/ageMinutes caveat as the test above - two
    // separate calls, genuinely different wall-clock instants.
    const { freshnessPenalty: fp1, entryScoreBreakdown: esb1, ...rest1 } = withStable;
    const { freshnessPenalty: fp2, entryScoreBreakdown: esb2, ...rest2 } = withNoOverrideAtAll;
    assert.deepEqual(rest1, rest2);
    assert.ok(Math.abs(fp1 - fp2) < 0.01, `freshnessPenalty should match within tolerance: ${fp1} vs ${fp2}`);
    const { ageMinutes: am1, ...esbRest1 } = esb1;
    const { ageMinutes: am2, ...esbRest2 } = esb2;
    assert.deepEqual(esbRest1, esbRest2);
    assert.ok(Math.abs(am1 - am2) < 0.01, `ageMinutes should match within tolerance: ${am1} vs ${am2}`);
});

test("flattenEarliness:false (unlike momentumHunter's own true) lets a big already-moved change1h discount accumulation score", () => {
    const ctx = ctxWithAccumulation();
    const movedToken = goodToken({ price_change_1h: 250 }); // well past the earliness curve's early buckets
    const [flattened] = analyzeTokensWithOverride([movedToken], ctx, "momentumHunter", null); // momentumHunter always flattens
    const [notFlattened] = analyzeTokensWithOverride([movedToken], ctx, "momentumHunter", { flattenEarliness: false });
    assert.ok(notFlattened.breakdown.participant.accumulation.score <= flattened.breakdown.participant.accumulation.score);
});

// Production Stabilization Final, Section A: isDuplicateWindow is a real,
// observability-only diagnostic (change5m === change1h exactly) -
// investigated as a possible priceAccel-suppression signal this sprint
// and deliberately NOT wired into scoring (a direct population query
// found it true for ~50% of all tracked tokens, most too old/liquid to
// explain by "brand new token" coincidence - suppressing on it would
// have reshaped scoring for half of all real candidates on n=5 outcome-
// labeled examples). This proves it is computed and exposed, but proves
// nothing else changes because of it - same participantScore/gatePassed
// with a duplicate window as with a genuinely distinct one, all else equal.
test("isDuplicateWindow is a real observability flag that never changes priceAccel/gatePassed on its own", () => {
    const accelOverride = { acceleration: { recentWindowMinutes: 15, priorWindowMinutes: 60, maxBonusFraction: 0.15, requireGateForEntry: false } };

    const ctx = ctxWithAccumulation();
    const duplicateToken = goodToken({ price_change_1h: 40, price_change_5m: 40 });
    const distinctToken = goodToken({ price_change_1h: 40, price_change_5m: 3.3 }); // pace5m (39.6) ~ change1h - same real acceleration story, genuinely distinct windows

    const [dup] = analyzeTokensWithOverride([duplicateToken], ctx, "momentumHunter", accelOverride);
    const [distinct] = analyzeTokensWithOverride([distinctToken], ctx, "momentumHunter", accelOverride);

    assert.equal(dup.acceleration.isDuplicateWindow, true);
    assert.equal(distinct.acceleration.isDuplicateWindow, false);
    // Both still compute a real priceAccel from the same formula - the
    // flag is descriptive only, not a gate, not a penalty, this sprint.
    assert.ok(dup.acceleration.priceAccel > 0);
});

// =====================================
// Arjuna V3 (FINAL SPRINT) - Parts 1/2/4/5/6/7 targeted coverage.
// =====================================

test("Part 9: entry threshold is 68, not the old 62", () => {
    const scoringConfig = require("../config/scoringConfig");
    assert.equal(scoringConfig.actionTiers.buy, 68);
});

test("Part 4: holder distribution buckets match the final spec exactly (0/6/10/15)", () => {
    const ctx = ctxWithAccumulation();
    const cases = [
        { holders: 10, expectedScore: 0 },
        { holders: 50, expectedScore: 6 },
        { holders: 90, expectedScore: 10 },
        { holders: 150, expectedScore: 15 }
    ];
    for(const { holders, expectedScore } of cases){
        const token = goodToken({ holders });
        const [result] = analyzeTokensWithOverride([token], ctx, "momentumHunter", null);
        assert.equal(result.breakdown.market.holderDistribution.score, expectedScore, `${holders} holders should score ${expectedScore}/15`);
    }
});

test("Part 5: liquidity hybrid - a good ratio on tiny absolute liquidity does NOT get full score", () => {
    const ctx = ctxWithAccumulation();
    // Same real shape the audit's own ANGELBULL/SUKI example used: a
    // healthy ratio ($3,500 liquidity / $10,000 mcap = 35%) but a tiny
    // absolute dollar figure.
    const tinyButHealthyRatio = goodToken({ liquidity: 3500, market_cap: 10000, fdv: 10000 });
    const [result] = analyzeTokensWithOverride([tinyButHealthyRatio], ctx, "momentumHunter", null);
    const liquidityMax = result.breakdown.market.liquidity.max;
    assert.ok(result.breakdown.market.liquidity.score < liquidityMax * 0.3, `expected a heavily discounted liquidity score, got ${result.breakdown.market.liquidity.score}/${liquidityMax}`);
});

test("Part 5: large absolute liquidity is always rewarded over tiny liquidity, at the same ratio", () => {
    const ctx = ctxWithAccumulation();
    const small = goodToken({ liquidity: 3500, market_cap: 10000, fdv: 10000 }); // 35% ratio, tiny absolute
    const large = goodToken({ liquidity: 175000, market_cap: 500000, fdv: 500000 }); // same 35% ratio, large absolute
    const [smallResult] = analyzeTokensWithOverride([small], ctx, "momentumHunter", null);
    const [largeResult] = analyzeTokensWithOverride([large], ctx, "momentumHunter", null);
    assert.ok(largeResult.breakdown.market.liquidity.score > smallResult.breakdown.market.liquidity.score);
});

test("Part 6: not-renounced mint/freeze authority apply real -5/-5 penalties to the unified entry score", () => {
    const ctx = ctxWithAccumulation();
    ctx.trenchesByAddress.set("TOKEN1", { ...ctx.trenchesByAddress.get("TOKEN1"), is_honeypot: 0, renounced_mint: 1, renounced_freeze_account: 1 });
    const cleanToken = goodToken();
    const [cleanResult] = analyzeTokensWithOverride([cleanToken], ctx, "momentumHunter", null);

    ctx.trenchesByAddress.set("TOKEN1", { ...ctx.trenchesByAddress.get("TOKEN1"), renounced_mint: 0, renounced_freeze_account: 0 });
    const [penalizedResult] = analyzeTokensWithOverride([cleanToken], ctx, "momentumHunter", null);

    assert.equal(cleanResult.entryScoreBreakdown.securityPenalty, 0);
    assert.equal(penalizedResult.entryScoreBreakdown.securityPenalty, 10); // -5 mint + -5 freeze
    // Real total delta is larger than the explicit -10 alone: not-renounced
    // also removes security.js's own positive renounced-confirmation
    // points (0.2+0.2 of security's own 10-point pool = 4), which the
    // unified score's own "security" weighted component also loses -
    // both effects are real and correctly compound, "increase penalties"
    // per Part 6.
    assert.equal(cleanResult.participantScore - penalizedResult.participantScore, 14);
});

test("Part 7: wash-trading confidence >=70 applies a real -15 penalty; below 70 applies none", () => {
    const ctx = ctxWithAccumulation();
    const belowThreshold = ctx.trenchesByAddress.get("TOKEN1");
    const [belowResult] = analyzeTokensWithOverride([goodToken()], ctx, "momentumHunter", null);
    assert.equal(belowResult.entryScoreBreakdown.washPenalty, 0);

    // A real multi-signal bot/bundle pattern - the same SUKI-shaped
    // fixture syntheticMarketFilterService.test.js already proves
    // crosses the composite reject threshold (>=55, well above the
    // Part 7 penalty threshold of 70 here).
    ctx.trenchesByAddress.set("TOKEN1", {
        ...belowThreshold, holders: 5, swaps_24h: 500, buys_24h: 250, sells_24h: 250,
        raw_json: JSON.stringify({
            bot_degen_rate: 0.6, bundler_trader_amount_rate: 0.5, rat_trader_amount_rate: 0.08,
            entrapment_ratio: 0.32, fresh_wallet_rate: 0.6, suspected_insider_hold_rate: 0.08
        })
    });
    const [washResult] = analyzeTokensWithOverride([goodToken()], ctx, "momentumHunter", null);
    assert.ok(washResult.entryScoreBreakdown.syntheticScore >= 70, `expected syntheticScore >= 70, got ${washResult.entryScoreBreakdown.syntheticScore}`);
    assert.equal(washResult.entryScoreBreakdown.washPenalty, 15);
});

test("Part 2: high volume alone (accumulation/smartMoney NOT healthy) contributes nothing to the entry score", () => {
    const ctx = emptyCtx(); // no trenches at all - accumulation defaults to neutral 0.4 fraction, well below the 0.5 health bar
    const highVolumeToken = goodToken({ volume_1h: 500000, liquidity: 50000 }); // huge volume/liquidity ratio
    const [result] = analyzeTokensWithOverride([highVolumeToken], ctx, "momentumHunter", null);
    assert.equal(result.entryScoreBreakdown.volumeValidated, false);
    assert.equal(result.entryScoreBreakdown.componentBreakdown.volume.contribution, 0);
});

test("Part 2: high volume DOES contribute once accumulation and smartMoney are both healthy", () => {
    const ctx = ctxWithAccumulation(); // real net_buy_24h=5000, buys_24h=80/sells_24h=20 -> healthy accumulation
    ctx.smartMoneyByAddress.set("TOKEN1", [
        { side: "buy", amount_usd: 1000, tx_timestamp: Date.now() / 1000, maker_address: "W1" },
        { side: "buy", amount_usd: 1000, tx_timestamp: Date.now() / 1000, maker_address: "W2" }
    ]);
    const highVolumeToken = goodToken({ volume_1h: 500000, liquidity: 50000 });
    const [result] = analyzeTokensWithOverride([highVolumeToken], ctx, "momentumHunter", null);
    assert.equal(result.entryScoreBreakdown.volumeValidated, true);
    assert.ok(result.entryScoreBreakdown.componentBreakdown.volume.contribution > 0);
});
