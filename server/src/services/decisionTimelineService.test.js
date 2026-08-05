// services/decisionTimelineService.test.js - Sprint 15 (Scientific
// Decision Framework), Phase 5. Proves the decaying-cadence policy
// (dense while young, sparse afterward, never silently skipped), the
// synthetic-facts extraction, and the safety invariant that a sample
// failure never throws. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const decisionTimelineService = require("./decisionTimelineService");
const decisionTimelineRepository = require("../repositories/decisionTimelineRepository");
const decisionEvidenceRepository = require("../repositories/decisionEvidenceRepository");
const db = require("../database/connection");

const PREFIX = "DECISIONTIMELINESVC_TEST_";

test.after(() => {
    db.prepare("DELETE FROM decision_timeline_samples WHERE token_address LIKE ?").run(`${PREFIX}%`);
    db.prepare("DELETE FROM decision_evidence WHERE token_address LIKE ?").run(`${PREFIX}%`);
});

function minutesAgoSqlite(minutes){
    return new Date(Date.now() - minutes * 60000).toISOString().slice(0, 19).replace("T", " ");
}

test("isSampleDue is always true within the dense window, regardless of any prior sample", () => {
    const position = { opened_at: minutesAgoSqlite(1) };
    assert.equal(decisionTimelineService.isSampleDue(position, 999999), true);
});

test("isSampleDue is true past the dense window when no sample has ever been recorded", () => {
    const position = { opened_at: minutesAgoSqlite(decisionTimelineService.DENSE_WINDOW_MINUTES + 1) };
    assert.equal(decisionTimelineService.isSampleDue(position, 999999), true);
});

test("isSampleDue is false past the dense window when the last sample is still within the sparse interval", () => {
    const decisionId = decisionEvidenceRepository.insertDecisionEvidence({ tokenAddress: `${PREFIX}A`, decisionEvidenceSchemaVersion: 1 });
    db.prepare("INSERT INTO decision_timeline_samples (decision_evidence_id, token_address, sample_time) VALUES (?, ?, ?)")
        .run(decisionId, `${PREFIX}A`, minutesAgoSqlite(1));
    const position = { opened_at: minutesAgoSqlite(decisionTimelineService.DENSE_WINDOW_MINUTES + 1) };
    assert.equal(decisionTimelineService.isSampleDue(position, decisionId), false);
});

test("isSampleDue is true past the dense window once the sparse interval has genuinely elapsed since the last sample", () => {
    const decisionId = decisionEvidenceRepository.insertDecisionEvidence({ tokenAddress: `${PREFIX}B`, decisionEvidenceSchemaVersion: 1 });
    db.prepare("INSERT INTO decision_timeline_samples (decision_evidence_id, token_address, sample_time) VALUES (?, ?, ?)")
        .run(decisionId, `${PREFIX}B`, minutesAgoSqlite(decisionTimelineService.SPARSE_SAMPLE_INTERVAL_MINUTES + 1));
    const position = { opened_at: minutesAgoSqlite(decisionTimelineService.DENSE_WINDOW_MINUTES + 5) };
    assert.equal(decisionTimelineService.isSampleDue(position, decisionId), true);
});

test("extractSyntheticFacts returns real nulls (never fabricated) when there is no trenches row at all", () => {
    assert.deepEqual(decisionTimelineService.extractSyntheticFacts(null), { bundlerTraderAmountRate: null, freshWalletRate: null, syntheticScore: null });
});

test("extractSyntheticFacts pulls the real raw_json fields and a real synthetic score when trenches data exists", () => {
    const trenches = { raw_json: JSON.stringify({ bundler_trader_amount_rate: 0.4, fresh_wallet_rate: 0.5 }) };
    const facts = decisionTimelineService.extractSyntheticFacts(trenches);
    assert.equal(facts.bundlerTraderAmountRate, 0.4);
    assert.equal(facts.freshWalletRate, 0.5);
    assert.ok(typeof facts.syntheticScore === "number");
});

test("maybeSampleForPosition returns null (never throws) when the position has no linked decision at all", () => {
    const position = { id: 999999999, token_address: `${PREFIX}NOLINK`, opened_at: minutesAgoSqlite(1) };
    const token = { token_address: `${PREFIX}NOLINK`, price: 1, liquidity: 1000, holders: 50 };
    assert.doesNotThrow(() => {
        assert.equal(decisionTimelineService.maybeSampleForPosition(position, token, null), null);
    });
});

test("maybeSampleForPosition never throws even given a null token", () => {
    assert.doesNotThrow(() => {
        assert.equal(decisionTimelineService.maybeSampleForPosition({ id: 1 }, null, null), null);
    });
});

test("maybeSampleForPosition writes a real, linked sample end to end when a decision exists and a sample is due", () => {
    const decisionId = decisionEvidenceRepository.insertDecisionEvidence({ tokenAddress: `${PREFIX}LINKED`, decisionEvidenceSchemaVersion: 1, linkedPositionId: 777001 });
    const position = { id: 777001, token_address: `${PREFIX}LINKED`, opened_at: minutesAgoSqlite(1) };
    const token = { token_address: `${PREFIX}LINKED`, price: 2.5, liquidity: 8000, holders: 120 };
    const trenches = { smart_degen_count: 4, raw_json: JSON.stringify({ bundler_trader_amount_rate: 0.1, fresh_wallet_rate: 0.2 }) };

    const sampleId = decisionTimelineService.maybeSampleForPosition(position, token, trenches);
    assert.ok(sampleId, "a real sample should have been recorded");

    const samples = decisionTimelineRepository.findByDecisionId(decisionId);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].price, 2.5);
    assert.equal(samples[0].smart_degen_count, 4);
    assert.equal(samples[0].bundler_trader_amount_rate, 0.1);
    assert.ok(samples[0].momentum_phase, "a real momentum phase classification must always be present");
});
