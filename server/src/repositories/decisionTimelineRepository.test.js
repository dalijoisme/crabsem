// repositories/decisionTimelineRepository.test.js - Sprint 15 (Scientific
// Decision Framework), Phase 5. Proves the insert/find surface and that
// no update/delete function exists on this module. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const decisionTimelineRepository = require("./decisionTimelineRepository");
const decisionEvidenceRepository = require("./decisionEvidenceRepository");
const db = require("../database/connection");

const PREFIX = "DECISIONTIMELINEREPO_TEST_";

let decisionEvidenceId;

test.before(() => {
    decisionEvidenceId = decisionEvidenceRepository.insertDecisionEvidence({
        tokenAddress: `${PREFIX}TOKEN1`, decisionEvidenceSchemaVersion: 1
    });
});

test.after(() => {
    db.prepare("DELETE FROM decision_timeline_samples WHERE token_address LIKE ?").run(`${PREFIX}%`);
    db.prepare("DELETE FROM decision_evidence WHERE token_address LIKE ?").run(`${PREFIX}%`);
});

test("no update or delete function is exposed on this module - structural immutability", () => {
    const exportedNames = Object.keys(decisionTimelineRepository);
    for(const name of exportedNames){
        assert.ok(!/update|delete|remove/i.test(name), `${name} looks like a mutation/deletion function`);
    }
});

test("insertSample writes a real row linked to its decision, defaulting omitted fields to null", () => {
    const id = decisionTimelineRepository.insertSample({ decisionEvidenceId, tokenAddress: `${PREFIX}TOKEN1`, price: 1.5 });
    const rows = decisionTimelineRepository.findByDecisionId(decisionEvidenceId);
    const row = rows.find(r => r.id === id);
    assert.equal(row.price, 1.5);
    assert.equal(row.liquidity, null);
});

test("findMostRecentSampleTime returns null when no sample exists yet, and the real latest time once one does", () => {
    const freshDecisionId = decisionEvidenceRepository.insertDecisionEvidence({ tokenAddress: `${PREFIX}TOKEN2`, decisionEvidenceSchemaVersion: 1 });
    assert.equal(decisionTimelineRepository.findMostRecentSampleTime(freshDecisionId), null);
    decisionTimelineRepository.insertSample({ decisionEvidenceId: freshDecisionId, tokenAddress: `${PREFIX}TOKEN2`, price: 1 });
    assert.ok(decisionTimelineRepository.findMostRecentSampleTime(freshDecisionId));
});

test("countByDecisionId reflects the real number of samples recorded for that decision only", () => {
    const otherDecisionId = decisionEvidenceRepository.insertDecisionEvidence({ tokenAddress: `${PREFIX}TOKEN3`, decisionEvidenceSchemaVersion: 1 });
    decisionTimelineRepository.insertSample({ decisionEvidenceId: otherDecisionId, tokenAddress: `${PREFIX}TOKEN3`, price: 1 });
    decisionTimelineRepository.insertSample({ decisionEvidenceId: otherDecisionId, tokenAddress: `${PREFIX}TOKEN3`, price: 2 });
    assert.equal(decisionTimelineRepository.countByDecisionId(otherDecisionId), 2);
    assert.equal(decisionTimelineRepository.countByDecisionId(decisionEvidenceId), 1);
});
