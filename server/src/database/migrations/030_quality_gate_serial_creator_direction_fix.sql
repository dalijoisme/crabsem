-- 030_quality_gate_serial_creator_direction_fix.sql - corrects a real
-- semantic bug found via live verification of migration 029's seeded
-- values: qualityGateService rejects when
-- creator_created_count > minSerialCreatorCount AND
-- creator_created_open_ratio < maxSerialCreatorOpenRatio - so a LOWER
-- minSerialCreatorCount and a HIGHER maxSerialCreatorOpenRatio both
-- make the check EASIER to trigger (stricter), the opposite direction
-- from maxRugRatio/maxTop10HolderRate's "lower = stricter" pattern.
-- Migration 029 set BASELINE's/AGGRESSIVE's values as if the direction
-- were the same as the other three thresholds, exactly reversing their
-- intended strictness on this one check (confirmed live: AGGRESSIVE's
-- REJECTED_SERIAL_SCAM_CREATOR_PATTERN count went UP, not down, right
-- after switching profiles). This migration fixes the 3 profiles whose
-- values were wrong (BASELINE/BALANCED/AGGRESSIVE - STABLE was already
-- correct at the engine defaults) and re-syncs the live bot's current
-- config row if it's actively running the fixed profile already.

UPDATE benchmark_profiles SET config_json = REPLACE(
    REPLACE(config_json, '"minSerialCreatorCount":700,"maxSerialCreatorOpenRatio":0.03', '"minSerialCreatorCount":300,"maxSerialCreatorOpenRatio":0.08'),
    '"maxSerialCreatorOpenRatio":0.03', '"maxSerialCreatorOpenRatio":0.08'
)
WHERE name = 'BASELINE' AND config_json LIKE '%"minSerialCreatorCount":700,"maxSerialCreatorOpenRatio":0.03%';

UPDATE benchmark_profiles SET config_json = REPLACE(
    config_json, '"minSerialCreatorCount":450,"maxSerialCreatorOpenRatio":0.06', '"minSerialCreatorCount":550,"maxSerialCreatorOpenRatio":0.04'
)
WHERE name = 'BALANCED' AND config_json LIKE '%"minSerialCreatorCount":450,"maxSerialCreatorOpenRatio":0.06%';

UPDATE benchmark_profiles SET config_json = REPLACE(
    config_json, '"minSerialCreatorCount":400,"maxSerialCreatorOpenRatio":0.07', '"minSerialCreatorCount":800,"maxSerialCreatorOpenRatio":0.02'
)
WHERE name = 'AGGRESSIVE' AND config_json LIKE '%"minSerialCreatorCount":400,"maxSerialCreatorOpenRatio":0.07%';

-- Re-sync trading_bot_config's current row IF it's still holding one
-- of the wrong seeded values verbatim (i.e. it was set by the buggy
-- 029 migration and never subsequently hand-edited) - never overwrite
-- a value that no longer matches the buggy default, since that means
-- it was deliberately changed since.
UPDATE trading_bot_config SET quality_gate_overrides_json =
    '{"maxRugRatio":0.50,"maxTop10HolderRate":0.45,"maxBundlerMhrWithLowLiquidity":0.85,"minSerialCreatorCount":300,"maxSerialCreatorOpenRatio":0.08}'
WHERE id = 1 AND strategy_profile = 'BASELINE'
  AND quality_gate_overrides_json = '{"maxRugRatio":0.50,"maxTop10HolderRate":0.45,"maxBundlerMhrWithLowLiquidity":0.85,"minSerialCreatorCount":700,"maxSerialCreatorOpenRatio":0.03}';

UPDATE trading_bot_config SET quality_gate_overrides_json =
    '{"maxRugRatio":0.72,"maxTop10HolderRate":0.62,"maxBundlerMhrWithLowLiquidity":0.96,"minSerialCreatorCount":550,"maxSerialCreatorOpenRatio":0.04}'
WHERE id = 1 AND strategy_profile = 'BALANCED'
  AND quality_gate_overrides_json = '{"maxRugRatio":0.72,"maxTop10HolderRate":0.62,"maxBundlerMhrWithLowLiquidity":0.96,"minSerialCreatorCount":450,"maxSerialCreatorOpenRatio":0.06}';

UPDATE trading_bot_config SET quality_gate_overrides_json =
    '{"maxRugRatio":0.75,"maxTop10HolderRate":0.65,"maxBundlerMhrWithLowLiquidity":0.97,"minSerialCreatorCount":800,"maxSerialCreatorOpenRatio":0.02}'
WHERE id = 1 AND strategy_profile = 'AGGRESSIVE'
  AND quality_gate_overrides_json = '{"maxRugRatio":0.75,"maxTop10HolderRate":0.65,"maxBundlerMhrWithLowLiquidity":0.97,"minSerialCreatorCount":400,"maxSerialCreatorOpenRatio":0.07}';
