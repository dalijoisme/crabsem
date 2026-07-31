-- Production Stabilization V1, Section J (Open Position fields): "Last
-- Update" needs a real timestamp of when current_price was actually
-- last refreshed - no such column existed before this, only the price
-- value itself. Stamped by updatePositionTracking() every real cycle a
-- position is evaluated (Section A's stale-price fix already ensures
-- this happens even for a token that fell out of the trending
-- snapshot). "Next Evaluation" is derived from this plus the user's own
-- real scan_interval_seconds - an honest estimate, computed at read
-- time, never stored.

ALTER TABLE trading_bot_positions ADD COLUMN price_updated_at TEXT;
