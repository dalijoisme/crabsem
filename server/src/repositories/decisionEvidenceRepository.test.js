// repositories/decisionEvidenceRepository.test.js - Sprint 15 (Scientific
// Decision Framework), Phase 3. Proves the insert/find surface, and -
// just as importantly - that no update/delete function exists on this
// module at all (see the repository's own header for why that's
// structural, not an oversight). Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const decisionEvidenceRepository = require("./decisionEvidenceRepository");
const db = require("../database/connection");

const PREFIX = "DECISIONEVIDENCEREPO_TEST_";

test.afterEach(() => {
    db.prepare("DELETE FROM decision_evidence WHERE token_address LIKE ?").run(`${PREFIX}%`);
    db.prepare("DELETE FROM decision_evidence_config_snapshots WHERE config_hash LIKE ?").run(`${PREFIX}%`);
});

function minimalRow(overrides = {}){
    return {
        tokenAddress: `${PREFIX}TOKEN1`,
        decisionEvidenceSchemaVersion: 1,
        ...overrides
    };
}

test("no update or delete function is exposed on this module - structural immutability, not a convention to remember", () => {
    const exportedNames = Object.keys(decisionEvidenceRepository);
    for(const name of exportedNames){
        assert.ok(!/update|delete|remove/i.test(name), `${name} looks like a mutation/deletion function - decision_evidence must stay append-only`);
    }
});

test("insertDecisionEvidence writes a real row and defaults every omitted field to null/REAL_BUY, never a fabricated value", () => {
    const id = decisionEvidenceRepository.insertDecisionEvidence(minimalRow());
    const row = decisionEvidenceRepository.findById(id);
    assert.equal(row.token_address, `${PREFIX}TOKEN1`);
    assert.equal(row.origin, "REAL_BUY");
    assert.equal(row.action, null);
    assert.equal(row.linked_trade_id, null);
    assert.equal(row.foundation_tier_json, null);
});

test("findByPositionId returns the row linked to that position, and null when nothing links to it", () => {
    decisionEvidenceRepository.insertDecisionEvidence(minimalRow({ linkedPositionId: 999901 }));
    const found = decisionEvidenceRepository.findByPositionId(999901);
    assert.equal(found.token_address, `${PREFIX}TOKEN1`);
    assert.equal(decisionEvidenceRepository.findByPositionId(999902), null);
});

test("findManyByTokenAddress returns real rows for that token, most recent first, and respects the limit", () => {
    decisionEvidenceRepository.insertDecisionEvidence(minimalRow({ tokenSymbol: "first" }));
    decisionEvidenceRepository.insertDecisionEvidence(minimalRow({ tokenSymbol: "second" }));
    const rows = decisionEvidenceRepository.findManyByTokenAddress(`${PREFIX}TOKEN1`, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_symbol, "second");
});

test("insertConfigSnapshotIfAbsent deduplicates by hash - inserting the same hash twice never creates a second row", () => {
    const hash = `${PREFIX}HASH1`;
    decisionEvidenceRepository.insertConfigSnapshotIfAbsent(hash, JSON.stringify({ a: 1 }));
    decisionEvidenceRepository.insertConfigSnapshotIfAbsent(hash, JSON.stringify({ a: 1 }));
    const count = db.prepare("SELECT COUNT(*) c FROM decision_evidence_config_snapshots WHERE config_hash = ?").get(hash).c;
    assert.equal(count, 1);
    assert.equal(decisionEvidenceRepository.findConfigSnapshotByHash(hash).config_json, JSON.stringify({ a: 1 }));
});

test("findConfigSnapshotByHash returns null for a hash never seen, never a fabricated row", () => {
    assert.equal(decisionEvidenceRepository.findConfigSnapshotByHash(`${PREFIX}NEVER_SEEN`), null);
});
