// services/decisionEvidenceService.test.js - Sprint 15 (Scientific
// Decision Framework), Phase 3/4. Proves the Foundation/Derived Tier
// assembly, Config Snapshot hashing/deduplication, Candidate Snapshot's
// Top-N cap, and - most importantly - the safety invariant that capture
// can never throw past its own boundary, no matter how broken its input
// is. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const decisionEvidenceService = require("./decisionEvidenceService");
const decisionEvidenceRepository = require("../repositories/decisionEvidenceRepository");
const db = require("../database/connection");

const PREFIX = "DECISIONEVIDENCESVC_TEST_";

test.afterEach(() => {
    db.prepare("DELETE FROM decision_evidence WHERE token_address LIKE ?").run(`${PREFIX}%`);
});

test("buildFoundationTier is a verbatim, null-safe passthrough of the real token/trenches rows", () => {
    const token = { token_address: "X", price: 1 };
    const trenches = { rug_ratio: 0.1 };
    const { tier } = decisionEvidenceService.buildFoundationTier(token, trenches);
    assert.equal(tier.token, token);
    assert.equal(tier.trenches, trenches);
    const { tier: tierNoTrenches } = decisionEvidenceService.buildFoundationTier(token, null);
    assert.equal(tierNoTrenches.trenches, null);
});

test("buildFoundationTier reports every required source missing when only token/trenches are supplied", () => {
    const { missingRawSources } = decisionEvidenceService.buildFoundationTier({ token_address: "X" }, { rug_ratio: 0.1 });
    assert.deepEqual(missingRawSources, ["peak", "realtimePulse", "activityFeed", "walletStats", "securityCache", "liquidityAtWindowStart"]);
});

test("buildFoundationTier's missing list shrinks exactly as extras are supplied - never a false COMPLETE", () => {
    const { missingRawSources } = decisionEvidenceService.buildFoundationTier(
        { token_address: "X" }, { rug_ratio: 0.1 },
        { peak: 1.5, realtimePulse: { signals: {} } }
    );
    assert.deepEqual(missingRawSources, ["activityFeed", "walletStats", "securityCache", "liquidityAtWindowStart"]);
});

test("computeFoundationTierCompleteness is COMPLETE only when every required source is present, PARTIAL_FOUNDATION otherwise", () => {
    assert.equal(decisionEvidenceService.computeFoundationTierCompleteness([]), "COMPLETE");
    assert.equal(decisionEvidenceService.computeFoundationTierCompleteness(["peak"]), "PARTIAL_FOUNDATION");
    assert.equal(decisionEvidenceService.computeFoundationTierCompleteness(decisionEvidenceService.FOUNDATION_TIER_REQUIRED_SOURCES), "PARTIAL_FOUNDATION");
});

test("buildDerivedTier pulls every real field off `live` and defaults absent ones to null/[], never fabricated", () => {
    const tier = decisionEvidenceService.buildDerivedTier({ action: "BUY", confidence: 80 });
    assert.equal(tier.action, "BUY");
    assert.equal(tier.confidence, 80);
    assert.equal(tier.risk, null);
    assert.deepEqual(tier.reasons, []);
    assert.deepEqual(tier.riskReasons, []);
    assert.equal(tier.entryGateResult, null);
});

test("buildDerivedTier folds in extras (tokenAgeMinutesAtEntry/rawFactsAtEntry/passReason) without touching live's own fields", () => {
    const tier = decisionEvidenceService.buildDerivedTier({ action: "BUY" }, { passReason: "because", tokenAgeMinutesAtEntry: 5 });
    assert.equal(tier.action, "BUY");
    assert.equal(tier.passReason, "because");
    assert.equal(tier.tokenAgeMinutesAtEntry, 5);
});

test("buildCandidateSnapshot returns null (never an empty array) when there were no real siblings", () => {
    assert.equal(decisionEvidenceService.buildCandidateSnapshot(null), null);
    assert.equal(decisionEvidenceService.buildCandidateSnapshot([]), null);
});

test("buildCandidateSnapshot caps at CANDIDATE_SNAPSHOT_TOP_N even when more real candidates existed that cycle", () => {
    const siblings = Array.from({ length: 25 }, (_, i) => ({ tokenAddress: `T${i}`, tokenSymbol: `S${i}`, rank: i, priorityScore: 100 - i }));
    const snapshot = decisionEvidenceService.buildCandidateSnapshot(siblings);
    assert.equal(snapshot.length, decisionEvidenceService.CANDIDATE_SNAPSHOT_TOP_N);
    assert.equal(snapshot[0].tokenAddress, "T0"); // the real ranked order is preserved, never re-sorted
});

test("buildCandidateSnapshot carries each sibling's own real derived-tier fields, not just rank", () => {
    const siblings = [{ tokenAddress: "T0", tokenSymbol: "S0", rank: 0, priorityScore: 90, action: "BUY", confidence: 70, risk: "LOW", participantScore: 72, marketHealth: 60, breakdown: { participant: {} } }];
    const [entry] = decisionEvidenceService.buildCandidateSnapshot(siblings);
    assert.equal(entry.action, "BUY");
    assert.equal(entry.confidence, 70);
    assert.deepEqual(entry.breakdown, { participant: {} });
});

test("hashConfig is deterministic - the same object always hashes the same, a different one hashes differently", () => {
    const a = decisionEvidenceService.hashConfig({ x: 1 });
    const b = decisionEvidenceService.hashConfig({ x: 1 });
    const c = decisionEvidenceService.hashConfig({ x: 2 });
    assert.equal(a.hash, b.hash);
    assert.notEqual(a.hash, c.hash);
});

test("buildGlobalConfigSnapshot returns the real, currently-loaded scoringConfig/syntheticMarketFilterConfig, not a copy that could drift", () => {
    const snapshot = decisionEvidenceService.buildGlobalConfigSnapshot();
    const scoringConfig = require("../config/scoringConfig");
    assert.equal(snapshot.scoringConfig.actionTiers.buy, scoringConfig.actionTiers.buy);
});

test("captureDecisionEvidence writes a real, complete row end to end, deduplicating the config snapshot", () => {
    const token = { token_address: `${PREFIX}TOKEN1`, symbol: "TEST", price: 1 };
    const live = { action: "BUY", confidence: 75, risk: "LOW", participantScore: 70, marketHealth: 55 };
    const config = { strategy_profile: "AGGRESSIVE" };

    const id1 = decisionEvidenceService.captureDecisionEvidence({ token, trenchesEntry: null, live, config, riskBands: null, userId: 8, engineVersion: "production_v2", positionId: 12345 });
    const id2 = decisionEvidenceService.captureDecisionEvidence({ token, trenchesEntry: null, live, config, riskBands: null, userId: 8, engineVersion: "production_v2", positionId: 12346 });

    const row1 = decisionEvidenceRepository.findById(id1);
    assert.equal(row1.action, "BUY");
    assert.equal(row1.user_id, 8);
    assert.equal(row1.linked_position_id, 12345);
    assert.ok(row1.config_hash);

    const row2 = decisionEvidenceRepository.findById(id2);
    // Same real global config both times (nothing changed between the two
    // calls) - must resolve to the exact same stored hash, never a second
    // duplicate snapshot row.
    assert.equal(row1.config_hash, row2.config_hash);

    // No momentumPhaseFacts.peak/breakdown.realtimePulse on this minimal
    // `live` fixture - honestly PARTIAL_FOUNDATION, never a false COMPLETE.
    assert.equal(row1.foundation_tier_completeness, "PARTIAL_FOUNDATION");
});

test("captureDecisionEvidence recovers real peak/realtimePulse from live when present, narrowing the missing-sources list", () => {
    const token = { token_address: `${PREFIX}TOKEN3`, symbol: "TEST3", price: 1 };
    const live = {
        action: "BUY", confidence: 75,
        momentumPhaseFacts: { peak: 1.23, drawdownFromPeak: 0.1 },
        breakdown: { realtimePulse: { tokenAddress: `${PREFIX}TOKEN3`, bufferLength: 3, signals: {} } }
    };
    const id = decisionEvidenceService.captureDecisionEvidence({ token, trenchesEntry: { rug_ratio: 0.1 }, live, config: {} });
    const row = decisionEvidenceRepository.findById(id);
    const foundation = JSON.parse(row.foundation_tier_json);
    assert.equal(foundation.peak, 1.23);
    assert.deepEqual(foundation.realtimePulse, { tokenAddress: `${PREFIX}TOKEN3`, bufferLength: 3, signals: {} });
    assert.deepEqual(foundation._missingRawSources, ["activityFeed", "walletStats", "securityCache", "liquidityAtWindowStart"]);
    assert.equal(row.foundation_tier_completeness, "PARTIAL_FOUNDATION");
});

test("captureDecisionEvidence never throws, even given completely broken input - returns null instead", () => {
    assert.doesNotThrow(() => {
        const result = decisionEvidenceService.captureDecisionEvidence({});
        assert.equal(result, null);
    });
    assert.doesNotThrow(() => {
        const result = decisionEvidenceService.captureDecisionEvidence({ token: null, live: null });
        assert.equal(result, null);
    });
});

test("captureDecisionEvidence stores candidateSnapshotJson as real null (not the string \"null\") when there were no siblings", () => {
    const token = { token_address: `${PREFIX}TOKEN2`, symbol: "TEST2", price: 1 };
    const id = decisionEvidenceService.captureDecisionEvidence({ token, live: { action: "BUY" }, config: {} });
    const row = decisionEvidenceRepository.findById(id);
    assert.equal(row.candidate_snapshot_json, null);
});
