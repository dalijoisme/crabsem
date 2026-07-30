-- 029_strategy_profile_engine_params.sql - Profile-Aware Production V2
-- refactor (approved architecture: floating-sauteeing-swan.md). Adds
-- the engine/gate/exit override fields Strategy Profile now controls -
-- weights, tiers, minLiquidityUsd, minVolumeUsd, flattenEarliness,
-- smBonus, quality-gate soft-filter thresholds, TP/SL, and the
-- momentum-weakening buyer-dominance ratio. Production V2 itself
-- (scoringConfig.js's safetyVeto/structuralValidation) is NOT touched -
-- these are all pre-existing per-call override slots on the engine's
-- already-generic philosophy mechanism, now made reachable from a
-- profile's own config instead of being fixed constants.
--
-- Every new column defaults to a value that reproduces TODAY'S
-- behavior exactly (NULL/off for the optional overrides, 15/0.5 for
-- fixed_tp_pct/momentum_weakening_buyer_dominance_ratio - the same
-- hardcoded values they replace) - a freshly migrated row is
-- byte-identical to pre-migration behavior until a profile is
-- switched or these fields are explicitly set.

ALTER TABLE trading_bot_config ADD COLUMN weights_json TEXT;
ALTER TABLE trading_bot_config ADD COLUMN tiers_json TEXT;
ALTER TABLE trading_bot_config ADD COLUMN min_liquidity_usd REAL;
ALTER TABLE trading_bot_config ADD COLUMN min_volume_usd REAL;
ALTER TABLE trading_bot_config ADD COLUMN flatten_earliness INTEGER NOT NULL DEFAULT 1;
ALTER TABLE trading_bot_config ADD COLUMN sm_bonus INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trading_bot_config ADD COLUMN quality_gate_overrides_json TEXT;
ALTER TABLE trading_bot_config ADD COLUMN fixed_tp_pct REAL NOT NULL DEFAULT 15;
ALTER TABLE trading_bot_config ADD COLUMN stop_loss_overrides_json TEXT;
ALTER TABLE trading_bot_config ADD COLUMN momentum_weakening_buyer_dominance_ratio REAL NOT NULL DEFAULT 0.5;

-- Backfill benchmark_profiles.config_json with the same new fields,
-- ONLY where the row is still byte-identical to its original 027 seed
-- (never overwrite a profile the user has since edited via the admin
-- API). BASELINE is reinterpreted here from "no Strategy Profile
-- layer" to the strictest/highest-precision layer, per the approved
-- architecture's explicit philosophy definitions.

UPDATE benchmark_profiles SET config_json =
    '{"min_confidence":60,"min_decay_fraction":0.90,"position_size_pct":20,"max_position_size":100,"max_open_positions":5,"cooldown_win_minutes":5,"cooldown_loss_minutes":30,"cooldown_reversal_minutes":15,"cooldown_default_minutes":10,"opportunity_priority_enabled":0,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100,' ||
    '"weights":{"developer":1.3,"sniperQuality":1.2,"bundleQuality":1.2,"insiderQuality":1.2,"liquidity":1.5,"security":1.5,"accumulation":0.8,"smartMoney":0.8,"kol":0.8},' ||
    '"tiers":{"buy":72,"strongBuy":88},"min_liquidity_usd":5000,"min_volume_usd":3000,"flatten_earliness":0,"sm_bonus":0,' ||
    '"quality_gate_overrides":{"maxRugRatio":0.50,"maxTop10HolderRate":0.45,"maxBundlerMhrWithLowLiquidity":0.85,"minSerialCreatorCount":700,"maxSerialCreatorOpenRatio":0.03},' ||
    '"fixed_tp_pct":20,"stop_loss_overrides":{"baseStopPct":10,"highRiskStopPct":6,"maxStopPct":30},"momentum_weakening_buyer_dominance_ratio":0.45}'
WHERE name = 'BASELINE' AND config_json = '{"min_confidence":60,"min_decay_fraction":0.90,"position_size_pct":20,"max_position_size":100,"max_open_positions":5,"cooldown_win_minutes":5,"cooldown_loss_minutes":30,"cooldown_reversal_minutes":15,"cooldown_default_minutes":10,"opportunity_priority_enabled":0,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100}';

UPDATE benchmark_profiles SET config_json =
    '{"min_confidence":65,"min_decay_fraction":0.90,"position_size_pct":10,"max_position_size":100,"max_open_positions":5,"cooldown_win_minutes":10,"cooldown_loss_minutes":45,"cooldown_reversal_minutes":20,"cooldown_default_minutes":15,"opportunity_priority_enabled":0,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100,' ||
    '"weights":{},"tiers":{},"min_liquidity_usd":null,"min_volume_usd":null,"flatten_earliness":1,"sm_bonus":0,' ||
    '"quality_gate_overrides":{},"fixed_tp_pct":15,"stop_loss_overrides":null,"momentum_weakening_buyer_dominance_ratio":0.5}'
WHERE name = 'STABLE' AND config_json = '{"min_confidence":65,"min_decay_fraction":0.90,"position_size_pct":10,"max_position_size":100,"max_open_positions":5,"cooldown_win_minutes":10,"cooldown_loss_minutes":45,"cooldown_reversal_minutes":20,"cooldown_default_minutes":15,"opportunity_priority_enabled":0,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100}';

UPDATE benchmark_profiles SET config_json =
    '{"min_confidence":60,"min_decay_fraction":0.90,"position_size_pct":15,"max_position_size":150,"max_open_positions":7,"cooldown_win_minutes":7,"cooldown_loss_minutes":30,"cooldown_reversal_minutes":15,"cooldown_default_minutes":10,"opportunity_priority_enabled":1,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100,' ||
    '"weights":{"accumulation":1.15,"smartMoney":1.15,"kol":1.1,"liquidity":0.9,"security":0.9},' ||
    '"tiers":{"buy":55,"strongBuy":75},"min_liquidity_usd":1500,"min_volume_usd":800,"flatten_earliness":1,"sm_bonus":0,' ||
    '"quality_gate_overrides":{"maxRugRatio":0.72,"maxTop10HolderRate":0.62,"maxBundlerMhrWithLowLiquidity":0.96,"minSerialCreatorCount":450,"maxSerialCreatorOpenRatio":0.06},' ||
    '"fixed_tp_pct":13,"stop_loss_overrides":{"baseStopPct":10,"highRiskStopPct":6,"maxStopPct":30},"momentum_weakening_buyer_dominance_ratio":0.55}'
WHERE name = 'BALANCED' AND config_json = '{"min_confidence":60,"min_decay_fraction":0.90,"position_size_pct":15,"max_position_size":150,"max_open_positions":7,"cooldown_win_minutes":7,"cooldown_loss_minutes":30,"cooldown_reversal_minutes":15,"cooldown_default_minutes":10,"opportunity_priority_enabled":1,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100}';

UPDATE benchmark_profiles SET config_json =
    '{"min_confidence":45,"min_decay_fraction":0.85,"position_size_pct":15,"max_position_size":150,"max_open_positions":10,"cooldown_win_minutes":5,"cooldown_loss_minutes":20,"cooldown_reversal_minutes":10,"cooldown_default_minutes":7,"opportunity_priority_enabled":1,"emi_enabled":1,"exit_strategy_variant":"dynamicExit","initial_capital":100,' ||
    '"weights":{"accumulation":1.6,"smartMoney":1.8,"kol":1.4,"whale":1.5,"developer":0.8,"sniperQuality":0.7,"bundleQuality":0.7,"insiderQuality":0.7,"holderDistribution":0.5,"volume":0.5,"priceStability":0.4},' ||
    '"tiers":{"buy":55,"strongBuy":75},"min_liquidity_usd":1200,"min_volume_usd":null,"flatten_earliness":1,"sm_bonus":1,' ||
    '"quality_gate_overrides":{"maxRugRatio":0.75,"maxTop10HolderRate":0.65,"maxBundlerMhrWithLowLiquidity":0.97,"minSerialCreatorCount":400,"maxSerialCreatorOpenRatio":0.07},' ||
    '"fixed_tp_pct":12,"stop_loss_overrides":{"baseStopPct":15,"highRiskStopPct":10,"maxStopPct":40},"momentum_weakening_buyer_dominance_ratio":0.55}'
WHERE name = 'AGGRESSIVE' AND config_json = '{"min_confidence":45,"min_decay_fraction":0.85,"position_size_pct":15,"max_position_size":150,"max_open_positions":10,"cooldown_win_minutes":5,"cooldown_loss_minutes":20,"cooldown_reversal_minutes":10,"cooldown_default_minutes":7,"opportunity_priority_enabled":1,"emi_enabled":1,"exit_strategy_variant":"dynamicExit","initial_capital":100}';
