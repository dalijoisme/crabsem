// services/opportunityPriorityService.test.js - unit tests for the pure
// ranking function only (rank() takes plain data, no DB access) - per
// Final Spec section 08/18: fixture-based, no integration harness
// needed for this milestone. Run with `node --test`.
//
// The B/C/A fixture below is hand-verified: 6 factors x 3 tokens (the
// 6th, riskDanger, ties at 0 for all three whenever riskReasonsByAddress
// is omitted - a strict no-op on relative order, same convention as
// acceleration/EMI being absent) with no accidental ties beyond the
// deliberate ones, producing combinedRank 0/4/10 (max 6*(3-1)=12) ->
// priorityScore 100/67/17 -> tier HEATING/WARM/NORMAL.

const test = require("node:test");
const assert = require("node:assert/strict");

const opportunityPriorityService = require("./opportunityPriorityService");

const tokens = [
    { token_address: "B", price_change_5m: 15 },
    { token_address: "C", price_change_5m: 8 },
    { token_address: "A", price_change_5m: 0 }
];

const batchContext = {
    historyByToken: new Map([
        ["B", [{ score: 70, confidence: 70, trigger_reason: "PARTICIPANT_SCORE_CHANGED_SIGNIFICANTLY" }, { score: 50, confidence: 50 }]],
        ["C", [{ score: 60, confidence: 60, trigger_reason: "VOLUME_SPIKE" }, { score: 50, confidence: 50 }]],
        ["A", [{ score: 50, confidence: 50, trigger_reason: "FIXED_REFRESH_TIMEOUT" }, { score: 50, confidence: 50 }]]
    ]),
    trenchesByToken: new Map([
        ["B", { buys_24h: 90, sells_24h: 10 }],
        ["C", { buys_24h: 70, sells_24h: 30 }]
        // "A" deliberately absent - no trenches data, must fall back to neutral 0.5 buyPressure.
    ])
};

function byAddress(result, address){
    return result.find(r => r.token.token_address === address);
}

test("rank() returns empty array for empty input", () => {
    const result = opportunityPriorityService.rank([], { historyByToken: new Map(), trenchesByToken: new Map() });
    assert.deepEqual(result, []);
});

test("rank() orders by combinedRank and derives the correct baseline tier for each", () => {

    const result = opportunityPriorityService.rank(tokens, batchContext);

    assert.deepEqual(result.map(r => r.token.token_address), ["B", "C", "A"]);

    const b = byAddress(result, "B"), c = byAddress(result, "C"), a = byAddress(result, "A");

    assert.equal(b.combinedRank, 0); assert.equal(b.priorityScore, 100); assert.equal(b.tier, "HEATING");
    assert.equal(c.combinedRank, 4); assert.equal(c.priorityScore, 67); assert.equal(c.tier, "WARM");
    assert.equal(a.combinedRank, 10); assert.equal(a.priorityScore, 17); assert.equal(a.tier, "NORMAL");

});

test("EMI accelerating=true on a NORMAL candidate raises it to WARM, never higher when priorityScore < 55", () => {

    const emiFlags = new Map([["A", { accelerating: true, reason: "PRICE_ACCELERATION_ONLY" }]]);
    const result = opportunityPriorityService.rank(tokens, batchContext, emiFlags);
    const a = byAddress(result, "A");

    assert.equal(a.tier, "WARM");
    // combinedRank/priorityScore are a pure reflection of the 6 real
    // factors - EMI must never change them, only the Tier bucket.
    assert.equal(a.combinedRank, 10);
    assert.equal(a.priorityScore, 17);

});

test("EMI accelerating=true on a WARM candidate with priorityScore >= 55 raises it to HEATING", () => {

    const emiFlags = new Map([["C", { accelerating: true, reason: "SIGNAL_AND_PRICE_ACCELERATION" }]]);
    const result = opportunityPriorityService.rank(tokens, batchContext, emiFlags);
    const c = byAddress(result, "C");

    assert.equal(c.tier, "HEATING");
    assert.equal(c.combinedRank, 4);
    assert.equal(c.priorityScore, 67);

});

test("a bumped candidate never outranks a naturally stronger same-tier candidate", () => {

    // C bumped from WARM to HEATING (same tier as B) must NOT let C beat
    // B - B's real combinedRank (0) is still better than C's (4), so the
    // tie-break inside the HEATING tier must keep B first.
    const emiFlags = new Map([["C", { accelerating: true, reason: "SIGNAL_AND_PRICE_ACCELERATION" }]]);
    const result = opportunityPriorityService.rank(tokens, batchContext, emiFlags);

    assert.deepEqual(result.map(r => r.token.token_address), ["B", "C", "A"]);

});

test("EMI on an already-HEATING candidate is a no-op", () => {

    const emiFlags = new Map([["B", { accelerating: true, reason: "SIGNAL_AND_PRICE_ACCELERATION" }]]);
    const result = opportunityPriorityService.rank(tokens, batchContext, emiFlags);
    const b = byAddress(result, "B");

    assert.equal(b.tier, "HEATING");

});

test("rank() never returns a NaN priorityScore for a single-candidate cycle", () => {
    const result = opportunityPriorityService.rank(
        [{ token_address: "A" }],
        { historyByToken: new Map(), trenchesByToken: new Map() }
    );
    assert.equal(result[0].priorityScore, 100);
    assert.equal(result[0].combinedRank, 0);
});

// Ranking-priority fix (real candidate priority, see the code's own
// comment on computeFactors): confidenceVelocity/participantScoreVelocity/
// triggerHeat used to read prediction_history - the STABLE-only house
// cache - which is meaningless for AGGRESSIVE's real per-cycle scoring
// (never written there). When a real acceleration signal is supplied,
// it must win over stale/irrelevant history, not just get averaged in.
test("a real acceleration signal overrides stale prediction_history factors, not just supplements them", () => {

    const staleHistoryTokens = [
        // X has a HOT-looking prediction_history trail (big score/confidence
        // jump, a real trigger) but its momentum has actually stopped -
        // acceleration reports nothing happening right now.
        { token_address: "X", price_change_5m: 0 },
        // Y has no interesting history at all, but real, live acceleration
        // evidence right now.
        { token_address: "Y", price_change_5m: 0 }
    ];

    const ctx = {
        historyByToken: new Map([
            ["X", [{ score: 90, confidence: 90, trigger_reason: "PARTICIPANT_SCORE_CHANGED_SIGNIFICANTLY" }, { score: 40, confidence: 40 }]],
            ["Y", [{ score: 50, confidence: 50, trigger_reason: "FIXED_REFRESH_TIMEOUT" }, { score: 50, confidence: 50 }]]
        ]),
        trenchesByToken: new Map()
    };

    const accelerationByAddress = new Map([
        ["X", { priceAccel: 0, flowAccel: 0, liquidityAccel: 0, compositeScore: 0, gatePassed: false }],
        ["Y", { priceAccel: 1, flowAccel: 1, liquidityAccel: 1, compositeScore: 1, gatePassed: true }]
    ]);

    // Without acceleration data (today's BALANCED behavior): X's hot
    // history wins.
    const withoutAcceleration = opportunityPriorityService.rank(staleHistoryTokens, ctx);
    assert.deepEqual(withoutAcceleration.map(r => r.token.token_address), ["X", "Y"]);

    // With real acceleration data supplied (AGGRESSIVE): Y's live evidence
    // must win over X's stale historical trail.
    const withAcceleration = opportunityPriorityService.rank(staleHistoryTokens, ctx, null, accelerationByAddress);
    assert.deepEqual(withAcceleration.map(r => r.token.token_address), ["Y", "X"]);

});

test("priceVelocity only rewards a token still rising, not a reversal down (sign fix)", () => {

    const tokensSigned = [
        { token_address: "RISING", price_change_5m: 20 },
        { token_address: "FALLING", price_change_5m: -20 }
    ];
    const emptyCtx = { historyByToken: new Map(), trenchesByToken: new Map() };

    const result = opportunityPriorityService.rank(tokensSigned, emptyCtx);

    // A -20% reversal must rank no better than a token with zero
    // movement, and strictly worse than the +20% still-rising token -
    // abs() used to make these two tie for "hottest."
    assert.deepEqual(result.map(r => r.token.token_address), ["RISING", "FALLING"]);
    assert.ok(result[0].combinedRank < result[1].combinedRank);

});

test("acceleration data is a strict no-op when absent (BALANCED/no-acceleration profiles unaffected)", () => {
    const withUndefined = opportunityPriorityService.rank(tokens, batchContext, null, undefined);
    const withoutParam = opportunityPriorityService.rank(tokens, batchContext);
    assert.deepEqual(withUndefined, withoutParam);
});

test("riskReasonsByAddress is a strict no-op when absent - byte-identical to before this factor existed", () => {
    const withUndefined = opportunityPriorityService.rank(tokens, batchContext, null, undefined, undefined);
    const withoutParam = opportunityPriorityService.rank(tokens, batchContext);
    assert.deepEqual(withUndefined, withoutParam);
});

// Production Stabilization V2 (Close Remaining BUY Blind Spots, Section
// 3 - Opportunity Ranking): a candidate with real, present risk flags
// must rank worse than an otherwise-identical candidate with none - the
// exact "momentum high but overall more dangerous" case the Founder
// asked ranking to be able to punish. Real proof this was needed:
// BABYCATE (a real HIGH-risk loser) ranked #0 of a real replay set on
// momentum alone before this fix - HIGH-risk candidates are already
// excluded from ranking entirely, so this test proves the same real
// danger signal now also matters among the MEDIUM/LOW-risk pool that
// still reaches ranking.
test("a candidate with more real risk flags ranks worse than an identical one with fewer, all else equal", () => {

    const riskyVsClean = [
        { token_address: "RISKY", price_change_5m: 10 },
        { token_address: "CLEAN", price_change_5m: 10 }
    ];
    const emptyCtx = { historyByToken: new Map(), trenchesByToken: new Map() };
    const riskReasonsByAddress = new Map([
        ["RISKY", ["Snipers hold 40% of top holdings", "High bundled/coordinated trading rate (35%)", "Price has already moved sharply"]],
        ["CLEAN", []]
    ]);

    const withoutRisk = opportunityPriorityService.rank(riskyVsClean, emptyCtx);
    assert.equal(withoutRisk[0].combinedRank, withoutRisk[1].combinedRank); // tied - momentum identical, no risk data supplied

    const withRisk = opportunityPriorityService.rank(riskyVsClean, emptyCtx, null, null, riskReasonsByAddress);
    assert.deepEqual(withRisk.map(r => r.token.token_address), ["CLEAN", "RISKY"]);
    assert.ok(withRisk[0].combinedRank < withRisk[1].combinedRank);

});
