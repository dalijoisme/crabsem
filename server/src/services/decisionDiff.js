// services/decisionDiff.js - Sprint 15 (Scientific Decision Framework),
// Phase 8. Compares two real signals (Engine A vs Engine B, both real
// output from researchEngineFactory.analyzeTokenWithPhilosophy - live,
// replayed, or one of each) at three layers, plus a human-readable
// summary computed ON TOP of the full structured diff, never in place
// of it - collapsing a real breakdown down to one sentence and
// discarding the rest is exactly the "computed then discarded" pattern
// this whole system exists to stop repeating.
//
// Divergence can come from three genuinely different places, and this
// file keeps them separate rather than flattening them into one number:
//   1. MODULE layer - same module, different weight or different score
//      (an interpretation or weighting change).
//   2. GATE layer - final action/risk differs even when every module
//      score matches (a tier/threshold/veto change).
//   3. CONTRIBUTION layer - the additive terms outside the weighted
//      module sum (security penalty, wash penalty, age bonus, momentum
//      modifier) - a change to one of THESE, not to any module.
//
// Purely a comparison function - never scores anything itself, never
// calls a repository, never replays anything (that's replayEngine.js's
// job, one layer up).

// Every real key config/scoringConfig.js's entryScore.weights can carry -
// mirrors researchEngineFactory.js's own computeUnifiedEntryScore, never
// re-derives its own list.
const ENTRY_SCORE_KEYS = [
    "smartMoney", "accumulation", "holderDistribution", "liquidity",
    "security", "developer", "sniperQuality", "insiderQuality", "volume", "priceStability"
];

function num(v){ return Number.isFinite(v) ? v : null; }

// Module layer - per weighted component, sorted by |deltaContribution|
// descending so the report reads "what actually moved the score most"
// first, not alphabetically.
function diffModules(signalA, signalB){
    const compA = signalA?.entryScoreBreakdown?.componentBreakdown || {};
    const compB = signalB?.entryScoreBreakdown?.componentBreakdown || {};

    const rows = ENTRY_SCORE_KEYS.map(key => {
        const a = compA[key] || {};
        const b = compB[key] || {};
        const contributionA = num(a.contribution) ?? 0;
        const contributionB = num(b.contribution) ?? 0;
        return {
            key,
            weightA: a.weight ?? null, weightB: b.weight ?? null,
            gatedA: a.gated ?? false, gatedB: b.gated ?? false,
            contributionA: a.contribution ?? null, contributionB: b.contribution ?? null,
            deltaContribution: Math.round((contributionB - contributionA) * 100) / 100
        };
    });

    return rows.sort((r1, r2) => Math.abs(r2.deltaContribution) - Math.abs(r1.deltaContribution));
}

// Gate layer - the final decision itself, and the facts most likely to
// explain why it differs even when no single module moved much (a
// safety veto, a tier change, a risk reclassification). Never inspects
// module scores - that's diffModules' job, kept separate on purpose.
function diffGate(signalA, signalB){
    return {
        actionA: signalA?.action ?? null, actionB: signalB?.action ?? null,
        actionChanged: (signalA?.action ?? null) !== (signalB?.action ?? null),
        riskA: signalA?.risk ?? null, riskB: signalB?.risk ?? null,
        confidenceA: signalA?.confidence ?? null, confidenceB: signalB?.confidence ?? null
    };
}

// Contribution layer - the additive terms computeUnifiedEntryScore adds
// on top of the weighted module sum. A real divergence here (e.g. a
// bundle/synthetic-orderflow reweighting) shows up as a change to
// washPenalty/securityPenalty, never as a module delta, which is exactly
// why this stays a separate layer instead of being folded into
// diffModules above.
function diffContribution(signalA, signalB){
    const a = signalA?.entryScoreBreakdown || {};
    const b = signalB?.entryScoreBreakdown || {};
    const terms = ["baseScore", "securityPenalty", "washPenalty", "ageBonusPoints", "momentumModifierPoints"];
    return Object.fromEntries(terms.map(term => [term, {
        a: a[term] ?? null, b: b[term] ?? null,
        delta: (num(b[term]) != null && num(a[term]) != null) ? Math.round((b[term] - a[term]) * 100) / 100 : null
    }]));
}

// A single, derived sentence for a human reading a report - computed
// from the full structured diff above, never a substitute for it (the
// caller always gets both). Picks whichever single factor (a module's
// contribution delta, or a contribution-layer term) accounts for the
// largest share of the total score movement.
function buildHumanSummary(gate, modules, contribution, totalDelta){
    if(gate.actionChanged){
        const topModule = modules[0];
        const causeLabel = topModule && Math.abs(topModule.deltaContribution) > 0
            ? `driven mainly by ${topModule.key} (Δcontribution ${topModule.deltaContribution >= 0 ? "+" : ""}${topModule.deltaContribution})`
            : "with no single module dominating the change";
        return `Action changed from ${gate.actionA ?? "?"} to ${gate.actionB ?? "?"} (score Δ${totalDelta >= 0 ? "+" : ""}${totalDelta}), ${causeLabel}.`;
    }
    return `Action unchanged (${gate.actionA ?? "?"}); score moved by ${totalDelta >= 0 ? "+" : ""}${totalDelta}.`;
}

// The full comparison - always returns all three layers plus the
// summary, never one in place of another.
function diffSignals(signalA, signalB){
    const modules = diffModules(signalA, signalB);
    const gate = diffGate(signalA, signalB);
    const contribution = diffContribution(signalA, signalB);

    const scoreA = num(signalA?.participantScore);
    const scoreB = num(signalB?.participantScore);
    const totalDelta = (scoreA != null && scoreB != null) ? Math.round((scoreB - scoreA) * 100) / 100 : null;

    return {
        totalScoreDelta: totalDelta,
        gate,
        modules,
        contribution,
        humanSummary: buildHumanSummary(gate, modules, contribution, totalDelta ?? 0)
    };
}

module.exports = { diffSignals, diffModules, diffGate, diffContribution, ENTRY_SCORE_KEYS };
