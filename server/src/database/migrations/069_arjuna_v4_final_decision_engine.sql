-- 069_arjuna_v4_final_decision_engine.sql - Arjuna V4 FINAL DECISION
-- ENGINE SPRINT. One additive, nullable column - every existing row
-- stays valid with no backfill required.
--
-- realtime_pulse_at_entry_json (migration 068) already persists the raw
-- Realtime Pulse signal set at entry. This column persists the SEPARATE,
-- downstream computation built on top of it: the real, Architect-
-- specified confidence adjustment (Token Age multiplier, Realtime Pulse/
-- Smart Money/KOL percentage adjustments, Fake Pump penalty, and the
-- combined multiplier actually applied to confidence) - see
-- services/realtimeConfidenceAdjustmentService.js. Needed so the Daily
-- Trading Review can measure each component's real effectiveness
-- (did a Pulse-boosted entry actually perform better than a Pulse-
-- penalized one) without re-deriving it from the raw Pulse signal every
-- time.

ALTER TABLE trading_bot_trades ADD COLUMN confidence_adjustment_at_entry_json TEXT;
