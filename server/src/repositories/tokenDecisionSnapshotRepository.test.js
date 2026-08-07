// repositories/tokenDecisionSnapshotRepository.test.js - Exit/entry
// engine optimization mission, Phase 5 (migration 074). Proves the
// decision-side time series: insert, ordered per-token history (oldest
// first, matching realtimePulseRepository.js's own convention), and
// retention pruning. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const repo = require("./tokenDecisionSnapshotRepository");
const db = require("../database/connection");

const PREFIX = "TOKDECSNAP_TEST_";

function snapshot(tokenAddress, overrides = {}){
    return {
        tokenAddress, recommendation: "BUY", confidence: 60, baseConfidence: 65,
        participantScore: 70, marketHealth: 55, risk: "LOW", momentumPhase: "EARLY_MOMENTUM",
        moduleScores: { participant: { smartMoney: { score: 20, max: 20, hasData: true } }, market: {} },
        ...overrides
    };
}

test.afterEach(() => {
    db.prepare("DELETE FROM token_decision_snapshots WHERE token_address LIKE ?").run(`${PREFIX}%`);
});

test("insertSnapshot stores a real row, findForToken reads it back with module_scores_json intact", () => {

    const address = `${PREFIX}A`;
    repo.insertSnapshot(snapshot(address, { confidence: 42 }));

    const rows = repo.findForToken(address);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].confidence, 42);
    assert.equal(rows[0].recommendation, "BUY");
    assert.equal(rows[0].momentum_phase, "EARLY_MOMENTUM");
    const modules = JSON.parse(rows[0].module_scores_json);
    assert.equal(modules.participant.smartMoney.score, 20);

});

test("insertSnapshot with a null moduleScores/risk/momentumPhase never throws - not every signal has real data every cycle", () => {

    const address = `${PREFIX}B`;
    repo.insertSnapshot({ tokenAddress: address, recommendation: "HOLD", confidence: 30, participantScore: 40, marketHealth: 20 });

    const rows = repo.findForToken(address);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].module_scores_json, null);
    assert.equal(rows[0].risk, null);

});

test("findForToken returns real per-token history oldest-first, for a confidence-evolution-before-BUY comparison", async () => {

    const address = `${PREFIX}C`;

    repo.insertSnapshot(snapshot(address, { confidence: 20 }));
    await new Promise(resolve => setTimeout(resolve, 20));
    repo.insertSnapshot(snapshot(address, { confidence: 45 }));
    await new Promise(resolve => setTimeout(resolve, 20));
    repo.insertSnapshot(snapshot(address, { confidence: 61 }));

    const rows = repo.findForToken(address);

    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => r.confidence), [20, 45, 61], "must read oldest-first - the real evolution leading up to eventual qualification");

});

test("findForToken never mixes different tokens' history together", () => {

    const addressA = `${PREFIX}D1`;
    const addressB = `${PREFIX}D2`;
    repo.insertSnapshot(snapshot(addressA, { confidence: 10 }));
    repo.insertSnapshot(snapshot(addressB, { confidence: 90 }));

    const rowsA = repo.findForToken(addressA);

    assert.equal(rowsA.length, 1);
    assert.equal(rowsA[0].confidence, 10);

});

test("pruneOlderThan only removes rows past the real age bound", async () => {

    const address = `${PREFIX}E`;
    repo.insertSnapshot(snapshot(address));

    await repo.pruneOlderThan(1000);
    assert.equal(repo.findForToken(address).length, 1);

    db.prepare("UPDATE token_decision_snapshots SET recorded_at = datetime('now', '-2 hours') WHERE token_address = ?").run(address);

    const deleted = await repo.pruneOlderThan(1);

    assert.ok(deleted >= 1);
    assert.equal(repo.findForToken(address).length, 0);

});

test("pruneOlderThan drains a backlog larger than one batch completely", async () => {

    const address = `${PREFIX}BATCH`;
    const rowCount = 250; // > the repository's own PRUNE_BATCH_SIZE (200)

    for(let i = 0; i < rowCount; i++) repo.insertSnapshot(snapshot(address, { confidence: i }));

    db.prepare("UPDATE token_decision_snapshots SET recorded_at = datetime('now', '-2 hours') WHERE token_address = ?").run(address);

    const deleted = await repo.pruneOlderThan(1);

    assert.equal(deleted, rowCount);
    const remaining = db.prepare("SELECT COUNT(*) c FROM token_decision_snapshots WHERE token_address = ?").get(address).c;
    assert.equal(remaining, 0);

});
