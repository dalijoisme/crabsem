-- 071_sprint15_foundation_tier_completeness.sql - Sprint 15 (Scientific
-- Decision Framework). One additive, nullable column - every existing
-- decision_evidence row stays valid with no backfill required (its real
-- value is simply unknown for rows captured before this migration,
-- correctly represented as NULL, never guessed).
--
-- COMPLETE | PARTIAL_FOUNDATION - computed by decisionEvidenceService.js
-- from which canonical raw Foundation Tier sources were actually present
-- at capture time (see FOUNDATION_TIER_REQUIRED_SOURCES there), so
-- future replay tooling can filter on this one column instead of
-- inspecting foundation_tier_json's own contents field by field.

ALTER TABLE decision_evidence ADD COLUMN foundation_tier_completeness TEXT;

CREATE INDEX IF NOT EXISTS idx_decision_evidence_completeness ON decision_evidence(foundation_tier_completeness);
