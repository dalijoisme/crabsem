// services/replayContextBuilder.test.js - Sprint 15 (Scientific Decision
// Framework), Phase 6. Proves buildReplayContext produces a Context-
// Contract-valid ctx from a real (or realistically-shaped) Decision
// Evidence record, degrades to real empty containers rather than
// throwing when Foundation Tier is only partial, and - the real proof
// this exists for - that the actual production scoring function
// (researchEngineFactory.analyzeTokensWithOverride) runs completely
// unmodified against a replayed ctx. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildReplayContext } = require("./replayContextBuilder");
const { CURRENT_CONTEXT_SCHEMA, assertValidContext } = require("./contextContract");
const decisionEvidenceService = require("./decisionEvidenceService");
const decisionEvidenceRepository = require("../repositories/decisionEvidenceRepository");
const researchEngineFactory = require("./researchEngineFactory");
const db = require("../database/connection");

const PREFIX = "REPLAYCTXBUILDER_TEST_";

test.after(() => {
    db.prepare("DELETE FROM decision_evidence WHERE token_address LIKE ?").run(`${PREFIX}%`);
});

test("buildReplayContext produces a ctx satisfying the exact same Context Contract preloadContext must satisfy", () => {
    const record = { token_address: `${PREFIX}A`, engine_version: "production_v2", foundation_tier_json: JSON.stringify({ trenches: { rug_ratio: 0.1 }, peak: 1.2 }) };
    const { ctx } = buildReplayContext(record);
    assert.doesNotThrow(() => assertValidContext(ctx, "test", CURRENT_CONTEXT_SCHEMA));
    assert.equal(ctx.trenchesByAddress.get(`${PREFIX}A`).rug_ratio, 0.1);
    assert.equal(ctx.peakPriceByAddress.get(`${PREFIX}A`), 1.2);
});

test("missing/never-captured raw sources become real empty Maps, never a thrown error", () => {
    const record = { token_address: `${PREFIX}B`, foundation_tier_json: JSON.stringify({ trenches: { rug_ratio: 0.1 }, _missingRawSources: ["peak", "realtimePulse", "activityFeed", "walletStats", "securityCache", "liquidityAtWindowStart"] }) };
    const { ctx, missingRawSources } = buildReplayContext(record);
    assert.equal(ctx.smartMoneyByAddress.size, 0);
    assert.equal(ctx.kolByAddress.size, 0);
    assert.equal(ctx.liquidityAtWindowStartByAddress.size, 0);
    assert.ok(Array.isArray(missingRawSources));
});

test("realtimePulseByAddress always has a real entry for the replayed token, even when no real pulse was captured - never absent", () => {
    const record = { token_address: `${PREFIX}NOPULSE`, foundation_tier_json: JSON.stringify({ trenches: { rug_ratio: 0.1 } }) };
    const { ctx } = buildReplayContext(record);
    const entry = ctx.realtimePulseByAddress.get(`${PREFIX}NOPULSE`);
    assert.ok(entry, "an entry must always exist, matching preloadContext's own live guarantee");
    assert.equal(entry.bufferLength, 0);
    assert.equal(entry.signals.smartMoneyNetUsd.velocity, null);
});

test("a completely missing or malformed foundation_tier_json never throws - produces an all-empty, still contract-valid ctx", () => {
    assert.doesNotThrow(() => buildReplayContext({ token_address: `${PREFIX}C`, foundation_tier_json: null }));
    assert.doesNotThrow(() => buildReplayContext({ token_address: `${PREFIX}C`, foundation_tier_json: "{not valid json" }));
    assert.doesNotThrow(() => buildReplayContext(undefined));
    const { ctx } = buildReplayContext(undefined);
    assert.equal(ctx.trenchesByAddress.size, 0);
});

test("buildReplayContext surfaces the real, already-computed completeness/missing-sources fields from the stored record, not a recomputation", () => {
    const record = { token_address: `${PREFIX}D`, foundation_tier_completeness: "PARTIAL_FOUNDATION", foundation_tier_json: JSON.stringify({ trenches: null, _missingRawSources: ["trenches", "activityFeed"] }) };
    const { foundationTierCompleteness, missingRawSources } = buildReplayContext(record);
    assert.equal(foundationTierCompleteness, "PARTIAL_FOUNDATION");
    assert.deepEqual(missingRawSources, ["trenches", "activityFeed"]);
});

// THE real proof: capture a genuine Decision Evidence record end to end,
// read it back, replay it, and confirm the exact same production scoring
// function (never a reimplementation) runs against the replayed ctx
// without modification and without throwing.
test("the real production scoring function runs unmodified against a replayed ctx built from a real captured decision", () => {
    const tokenAddress = `${PREFIX}REALSCORE`;
    const token = {
        token_address: tokenAddress, price: 0.001, market_cap: 1000000, liquidity: 50000, holders: 200,
        volume_1h: 30000, price_change_1h: 20, price_change_5m: 1,
        updated_at: new Date().toISOString().slice(0, 19).replace("T", " ")
    };
    const trenchesEntry = { net_buy_24h: 5000, buys_24h: 80, sells_24h: 20, rug_ratio: 0.1, top_10_holder_rate: 0.2, is_honeypot: 0, smart_degen_count: 0 };
    const live = { action: "BUY", confidence: 80, participantScore: 70, marketHealth: 60 };

    const id = decisionEvidenceService.captureDecisionEvidence({ token, trenchesEntry, live, config: {} });
    const record = decisionEvidenceRepository.findById(id);

    const { ctx } = buildReplayContext(record);

    // The SAME real function analyzeTokenWithPhilosophy's own live callers
    // use - never a reimplementation, never a replay-specific branch.
    const [replayedSignal] = researchEngineFactory.analyzeTokensWithOverride([token], ctx, "momentumHunter", null);

    assert.ok(["BUY", "STRONG BUY", "HOLD", "AVOID"].includes(replayedSignal.action), "the real engine must produce a real, valid action from replayed evidence");
    assert.equal(typeof replayedSignal.participantScore, "number");
    // The replayed trenches data is the exact real row captured at
    // decision time - accumulation.js reads it directly, so a real,
    // non-neutral accumulation signal proves the replayed ctx's trenches
    // data genuinely reached the real scoring module, not a stub.
    assert.equal(replayedSignal.breakdown.participant.accumulation.hasData, true);
});
