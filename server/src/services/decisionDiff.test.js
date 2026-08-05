// services/decisionDiff.test.js - Sprint 15 (Scientific Decision
// Framework), Phase 8. Proves the three layers stay genuinely separate
// (a module-only change never shows up as a gate change and vice versa),
// module rows sort by real impact rather than alphabetically, and the
// human summary is a derived addition, never a replacement for the full
// structured diff. DB-free - decisionDiff.js is a pure comparison
// function. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const decisionDiff = require("./decisionDiff");

function signal(overrides = {}){
    return {
        action: "BUY", risk: "LOW", confidence: 80, participantScore: 70,
        entryScoreBreakdown: {
            baseScore: 70, securityPenalty: 0, washPenalty: 0, ageBonusPoints: 5, momentumModifierPoints: 0,
            componentBreakdown: {
                smartMoney: { weight: 20, contribution: 15, gated: false },
                accumulation: { weight: 18, contribution: 12, gated: false },
                holderDistribution: { weight: 15, contribution: 10, gated: false },
                liquidity: { weight: 15, contribution: 10, gated: false },
                security: { weight: 10, contribution: 10, gated: false },
                developer: { weight: 8, contribution: 4, gated: false },
                sniperQuality: { weight: 5, contribution: 5, gated: false },
                insiderQuality: { weight: 4, contribution: 4, gated: false },
                volume: { weight: 3, contribution: 0, gated: true },
                priceStability: { weight: 2, contribution: 2, gated: false }
            }
        },
        breakdown: { participant: { accumulation: { max: 18 } } },
        ...overrides
    };
}

test("diffModules sorts by |deltaContribution| descending, not alphabetically", () => {
    const a = signal();
    const b = signal({ entryScoreBreakdown: { ...a.entryScoreBreakdown, componentBreakdown: {
        ...a.entryScoreBreakdown.componentBreakdown,
        accumulation: { weight: 18, contribution: 12, gated: false }, // unchanged
        priceStability: { weight: 2, contribution: 2, gated: false }, // unchanged
        smartMoney: { weight: 20, contribution: 2, gated: false } // real, large drop
    } } });
    const modules = decisionDiff.diffModules(a, b);
    assert.equal(modules[0].key, "smartMoney", "the module with the real largest contribution swing must sort first");
    assert.equal(modules[0].deltaContribution, -13);
});

test("diffGate reports actionChanged only when the action genuinely differs, never on confidence/risk alone", () => {
    const a = signal({ action: "BUY" });
    const bSameAction = signal({ action: "BUY", confidence: 50 });
    const bDifferentAction = signal({ action: "HOLD" });
    assert.equal(decisionDiff.diffGate(a, bSameAction).actionChanged, false);
    assert.equal(decisionDiff.diffGate(a, bDifferentAction).actionChanged, true);
});

test("a pure module-weighting change never appears as a gate-layer difference, and vice versa - the three layers stay genuinely separate", () => {
    const a = signal();
    const bModuleOnly = signal({ entryScoreBreakdown: { ...a.entryScoreBreakdown, componentBreakdown: {
        ...a.entryScoreBreakdown.componentBreakdown,
        smartMoney: { weight: 20, contribution: 5, gated: false }
    } } }); // action/risk/confidence untouched
    const diff = decisionDiff.diffSignals(a, bModuleOnly);
    assert.equal(diff.gate.actionChanged, false);
    assert.notEqual(diff.modules.find(m => m.key === "smartMoney").deltaContribution, 0);
});

test("diffContribution isolates the additive terms outside the weighted module sum", () => {
    const a = signal();
    const b = signal({ entryScoreBreakdown: { ...a.entryScoreBreakdown, washPenalty: 15 } });
    const contribution = decisionDiff.diffContribution(a, b);
    assert.equal(contribution.washPenalty.delta, 15);
    assert.equal(contribution.baseScore.delta, 0);
});

test("diffSignals always returns all three layers plus a human summary - never one instead of another", () => {
    const diff = decisionDiff.diffSignals(signal(), signal({ action: "AVOID" }));
    assert.ok(diff.gate);
    assert.ok(Array.isArray(diff.modules));
    assert.ok(diff.contribution);
    assert.equal(typeof diff.humanSummary, "string");
    assert.ok(diff.humanSummary.includes("AVOID"), "the human summary must reference the real changed action, not a generic placeholder");
});

test("humanSummary names the real dominant module by contribution delta, not just the fact that something changed", () => {
    const a = signal();
    const b = signal({ action: "HOLD", entryScoreBreakdown: { ...a.entryScoreBreakdown, componentBreakdown: {
        ...a.entryScoreBreakdown.componentBreakdown,
        smartMoney: { weight: 20, contribution: 0, gated: false }
    } } });
    const diff = decisionDiff.diffSignals(a, b);
    assert.ok(diff.humanSummary.includes("smartMoney"));
});
