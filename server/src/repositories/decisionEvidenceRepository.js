// repositories/decisionEvidenceRepository.js - Sprint 15 (Scientific
// Decision Framework), Phase 3/4. The ONLY place that reads/writes
// decision_evidence / decision_evidence_config_snapshots.
//
// DELIBERATE, STRUCTURAL: this file exposes insert/find functions only -
// no update, no delete, for either table, anywhere in this module. That
// is not an oversight to fill in later; it is the entire point (see
// migration 070's own header, and the Sprint 15 architecture's
// "Replay Purity"/immutability discussion). If a future need seems to
// require updating a decision_evidence row, the correct fix is a new
// row referencing the old one (e.g. a `derived_from_id` column added by
// a later migration), never an UPDATE statement added here.

const db = require("../database/connection");

const insertConfigSnapshotStmt = db.prepare(`
    INSERT OR IGNORE INTO decision_evidence_config_snapshots (config_hash, config_json)
    VALUES (@configHash, @configJson)
`);

// Insert-if-absent by design (INSERT OR IGNORE) - the whole reason this
// table is keyed by content hash is so the same resolved config, reused
// across many decisions between real tuning changes, is stored exactly
// once. A hash collision on genuinely different content never happens in
// practice (sha256) and is out of scope to defend against here.
function insertConfigSnapshotIfAbsent(configHash, configJson){
    insertConfigSnapshotStmt.run({ configHash, configJson });
    return configHash;
}

function findConfigSnapshotByHash(configHash){
    return db.prepare("SELECT * FROM decision_evidence_config_snapshots WHERE config_hash = ?").get(configHash) ?? null;
}

const insertDecisionEvidenceStmt = db.prepare(`
    INSERT INTO decision_evidence (
        token_address, token_symbol, user_id, engine_version, strategy_profile, origin,
        action, confidence, risk, participant_score, market_health,
        decision_evidence_schema_version, context_schema_version, foundation_tier_completeness,
        foundation_tier_json, derived_tier_json,
        config_hash, per_user_config_json, trade_plan_json, candidate_snapshot_json,
        linked_position_id, linked_trade_id
    ) VALUES (
        @tokenAddress, @tokenSymbol, @userId, @engineVersion, @strategyProfile, @origin,
        @action, @confidence, @risk, @participantScore, @marketHealth,
        @decisionEvidenceSchemaVersion, @contextSchemaVersion, @foundationTierCompleteness,
        @foundationTierJson, @derivedTierJson,
        @configHash, @perUserConfigJson, @tradePlanJson, @candidateSnapshotJson,
        @linkedPositionId, @linkedTradeId
    )
`);

// row: see decisionEvidenceService.js's captureDecisionEvidence for the
// exact shape this expects - this function does no assembly of its own,
// purely a write. Every field defaults to null when the caller omits it
// (a genuinely optional/not-yet-known value, e.g. linked_trade_id before
// a position ever closes), never a fabricated placeholder.
function insertDecisionEvidence(row){
    const info = insertDecisionEvidenceStmt.run({
        tokenSymbol: null, userId: null, engineVersion: null, strategyProfile: null, origin: "REAL_BUY",
        action: null, confidence: null, risk: null, participantScore: null, marketHealth: null,
        contextSchemaVersion: null, foundationTierCompleteness: null,
        foundationTierJson: null, derivedTierJson: null,
        configHash: null, perUserConfigJson: null, tradePlanJson: null, candidateSnapshotJson: null,
        linkedPositionId: null, linkedTradeId: null,
        ...row
    });
    return info.lastInsertRowid;
}

function findById(id){
    return db.prepare("SELECT * FROM decision_evidence WHERE id = ?").get(id) ?? null;
}

function findByPositionId(positionId){
    return db.prepare("SELECT * FROM decision_evidence WHERE linked_position_id = ?").get(positionId) ?? null;
}

// id DESC as the tiebreaker, not decision_time alone - SQLite's
// CURRENT_TIMESTAMP default is second-resolution, so two real decisions
// in the same second would otherwise sort ambiguously; id (AUTOINCREMENT)
// always reflects real insertion order.
function findManyByTokenAddress(tokenAddress, limit = 50){
    return db.prepare("SELECT * FROM decision_evidence WHERE token_address = ? ORDER BY decision_time DESC, id DESC LIMIT ?").all(tokenAddress, limit);
}

module.exports = {
    insertConfigSnapshotIfAbsent, findConfigSnapshotByHash,
    insertDecisionEvidence, findById, findByPositionId, findManyByTokenAddress
};
