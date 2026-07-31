-- Production Stabilization V1: verified the real BUY pipeline
-- (scheduler -> engine -> tradeManager.openPosition) already persists a
-- complete scores/reasons/confidence/module-breakdown/engine-version
-- snapshot per position (breakdown_json, confidence, risk, engine_version
-- columns) - confirmed via a real end-to-end cycle, not assumed. The one
-- genuinely missing piece: no column captures WHICH trading_bot_config
-- was active at the moment of that exact BUY, so a later config change
-- (profile switch, Trading Configuration edit) makes it impossible to
-- know what settings actually produced a historical decision. This is
-- additive/nullable - existing rows simply have no snapshot, honestly,
-- never a fabricated one.

ALTER TABLE trading_bot_positions ADD COLUMN config_snapshot_json TEXT;
