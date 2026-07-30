-- 032_strategy_profile_acceleration.sql - Early Momentum Hunter
-- philosophy refactor. Aggressive stops asking "is this coin already
-- good?" (every other profile's question, just with a lower bar) and
-- starts asking "is this coin accelerating right now?" - a genuinely
-- different objective, not a looser threshold. See
-- services/researchEngineFactory.js's computeAccelerationSignal for
-- the real, already-collected time-series data this reads (gmgn_tokens
-- price_change_5m/1h, gmgn_activity_feed tx_timestamp, token_price_history).
--
-- New column defaults to NULL - a strict no-op reproducing today's
-- behavior exactly (same convention as migration 029) until a profile
-- is (re-)selected through the admin API.

ALTER TABLE trading_bot_config ADD COLUMN acceleration_overrides_json TEXT;

-- Backfill benchmark_profiles.config_json with the same new field,
-- ONLY where the row is still byte-identical to its 029 seed (never
-- overwrite a profile the user has since edited via the admin API).

UPDATE benchmark_profiles SET config_json =
    '{"min_confidence":60,"min_decay_fraction":0.90,"position_size_pct":20,"max_position_size":100,"max_open_positions":5,"cooldown_win_minutes":5,"cooldown_loss_minutes":30,"cooldown_reversal_minutes":15,"cooldown_default_minutes":10,"opportunity_priority_enabled":0,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100,' ||
    '"weights":{"developer":1.3,"sniperQuality":1.2,"bundleQuality":1.2,"insiderQuality":1.2,"liquidity":1.5,"security":1.5,"accumulation":0.8,"smartMoney":0.8,"kol":0.8},' ||
    '"tiers":{"buy":72,"strongBuy":88},"min_liquidity_usd":5000,"min_volume_usd":3000,"flatten_earliness":0,"sm_bonus":0,' ||
    '"quality_gate_overrides":{"maxRugRatio":0.50,"maxTop10HolderRate":0.45,"maxBundlerMhrWithLowLiquidity":0.85,"minSerialCreatorCount":300,"maxSerialCreatorOpenRatio":0.08},' ||
    '"fixed_tp_pct":20,"stop_loss_overrides":{"baseStopPct":10,"highRiskStopPct":6,"maxStopPct":30},"momentum_weakening_buyer_dominance_ratio":0.45,"acceleration_overrides":null}'
WHERE name = 'BASELINE' AND config_json = '{"min_confidence":60,"min_decay_fraction":0.90,"position_size_pct":20,"max_position_size":100,"max_open_positions":5,"cooldown_win_minutes":5,"cooldown_loss_minutes":30,"cooldown_reversal_minutes":15,"cooldown_default_minutes":10,"opportunity_priority_enabled":0,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100,"weights":{"developer":1.3,"sniperQuality":1.2,"bundleQuality":1.2,"insiderQuality":1.2,"liquidity":1.5,"security":1.5,"accumulation":0.8,"smartMoney":0.8,"kol":0.8},"tiers":{"buy":72,"strongBuy":88},"min_liquidity_usd":5000,"min_volume_usd":3000,"flatten_earliness":0,"sm_bonus":0,"quality_gate_overrides":{"maxRugRatio":0.50,"maxTop10HolderRate":0.45,"maxBundlerMhrWithLowLiquidity":0.85,"minSerialCreatorCount":300,"maxSerialCreatorOpenRatio":0.08},"fixed_tp_pct":20,"stop_loss_overrides":{"baseStopPct":10,"highRiskStopPct":6,"maxStopPct":30},"momentum_weakening_buyer_dominance_ratio":0.45}';

UPDATE benchmark_profiles SET config_json =
    '{"min_confidence":65,"min_decay_fraction":0.90,"position_size_pct":10,"max_position_size":100,"max_open_positions":5,"cooldown_win_minutes":10,"cooldown_loss_minutes":45,"cooldown_reversal_minutes":20,"cooldown_default_minutes":15,"opportunity_priority_enabled":0,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100,' ||
    '"weights":{},"tiers":{},"min_liquidity_usd":null,"min_volume_usd":null,"flatten_earliness":1,"sm_bonus":0,' ||
    '"quality_gate_overrides":{},"fixed_tp_pct":15,"stop_loss_overrides":null,"momentum_weakening_buyer_dominance_ratio":0.5,"acceleration_overrides":null}'
WHERE name = 'STABLE' AND config_json = '{"min_confidence":65,"min_decay_fraction":0.90,"position_size_pct":10,"max_position_size":100,"max_open_positions":5,"cooldown_win_minutes":10,"cooldown_loss_minutes":45,"cooldown_reversal_minutes":20,"cooldown_default_minutes":15,"opportunity_priority_enabled":0,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100,"weights":{},"tiers":{},"min_liquidity_usd":null,"min_volume_usd":null,"flatten_earliness":1,"sm_bonus":0,"quality_gate_overrides":{},"fixed_tp_pct":15,"stop_loss_overrides":null,"momentum_weakening_buyer_dominance_ratio":0.5}';

UPDATE benchmark_profiles SET config_json =
    '{"min_confidence":60,"min_decay_fraction":0.90,"position_size_pct":15,"max_position_size":150,"max_open_positions":7,"cooldown_win_minutes":7,"cooldown_loss_minutes":30,"cooldown_reversal_minutes":15,"cooldown_default_minutes":10,"opportunity_priority_enabled":1,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100,' ||
    '"weights":{"accumulation":1.15,"smartMoney":1.15,"kol":1.1,"liquidity":0.9,"security":0.9},' ||
    '"tiers":{"buy":55,"strongBuy":75},"min_liquidity_usd":1500,"min_volume_usd":800,"flatten_earliness":1,"sm_bonus":0,' ||
    '"quality_gate_overrides":{"maxRugRatio":0.72,"maxTop10HolderRate":0.62,"maxBundlerMhrWithLowLiquidity":0.96,"minSerialCreatorCount":550,"maxSerialCreatorOpenRatio":0.04},' ||
    '"fixed_tp_pct":13,"stop_loss_overrides":{"baseStopPct":10,"highRiskStopPct":6,"maxStopPct":30},"momentum_weakening_buyer_dominance_ratio":0.55,"acceleration_overrides":null}'
WHERE name = 'BALANCED' AND config_json = '{"min_confidence":60,"min_decay_fraction":0.90,"position_size_pct":15,"max_position_size":150,"max_open_positions":7,"cooldown_win_minutes":7,"cooldown_loss_minutes":30,"cooldown_reversal_minutes":15,"cooldown_default_minutes":10,"opportunity_priority_enabled":1,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100,"weights":{"accumulation":1.15,"smartMoney":1.15,"kol":1.1,"liquidity":0.9,"security":0.9},"tiers":{"buy":55,"strongBuy":75},"min_liquidity_usd":1500,"min_volume_usd":800,"flatten_earliness":1,"sm_bonus":0,"quality_gate_overrides":{"maxRugRatio":0.72,"maxTop10HolderRate":0.62,"maxBundlerMhrWithLowLiquidity":0.96,"minSerialCreatorCount":550,"maxSerialCreatorOpenRatio":0.04},"fixed_tp_pct":13,"stop_loss_overrides":{"baseStopPct":10,"highRiskStopPct":6,"maxStopPct":30},"momentum_weakening_buyer_dominance_ratio":0.55}';

UPDATE benchmark_profiles SET config_json =
    '{"min_confidence":45,"min_decay_fraction":0.85,"position_size_pct":15,"max_position_size":150,"max_open_positions":10,"cooldown_win_minutes":5,"cooldown_loss_minutes":20,"cooldown_reversal_minutes":10,"cooldown_default_minutes":7,"opportunity_priority_enabled":1,"emi_enabled":1,"exit_strategy_variant":"dynamicExit","initial_capital":100,' ||
    '"weights":{"accumulation":1.6,"smartMoney":1.8,"kol":1.4,"whale":1.5,"developer":0.8,"sniperQuality":0.7,"bundleQuality":0.7,"insiderQuality":0.7,"holderDistribution":0.5,"volume":0.5,"priceStability":0.4},' ||
    '"tiers":{"buy":55,"strongBuy":75},"min_liquidity_usd":1200,"min_volume_usd":null,"flatten_earliness":1,"sm_bonus":1,' ||
    '"quality_gate_overrides":{"maxRugRatio":0.75,"maxTop10HolderRate":0.65,"maxBundlerMhrWithLowLiquidity":0.97,"minSerialCreatorCount":800,"maxSerialCreatorOpenRatio":0.02},' ||
    '"fixed_tp_pct":12,"stop_loss_overrides":{"baseStopPct":15,"highRiskStopPct":10,"maxStopPct":40},"momentum_weakening_buyer_dominance_ratio":0.55,' ||
    '"acceleration_overrides":{"recentWindowMinutes":15,"priorWindowMinutes":60,"maxBonusFraction":0.15,"requireGateForEntry":true}}'
WHERE name = 'AGGRESSIVE' AND config_json = '{"min_confidence":45,"min_decay_fraction":0.85,"position_size_pct":15,"max_position_size":150,"max_open_positions":10,"cooldown_win_minutes":5,"cooldown_loss_minutes":20,"cooldown_reversal_minutes":10,"cooldown_default_minutes":7,"opportunity_priority_enabled":1,"emi_enabled":1,"exit_strategy_variant":"dynamicExit","initial_capital":100,"weights":{"accumulation":1.6,"smartMoney":1.8,"kol":1.4,"whale":1.5,"developer":0.8,"sniperQuality":0.7,"bundleQuality":0.7,"insiderQuality":0.7,"holderDistribution":0.5,"volume":0.5,"priceStability":0.4},"tiers":{"buy":55,"strongBuy":75},"min_liquidity_usd":1200,"min_volume_usd":null,"flatten_earliness":1,"sm_bonus":1,"quality_gate_overrides":{"maxRugRatio":0.75,"maxTop10HolderRate":0.65,"maxBundlerMhrWithLowLiquidity":0.97,"minSerialCreatorCount":800,"maxSerialCreatorOpenRatio":0.02},"fixed_tp_pct":12,"stop_loss_overrides":{"baseStopPct":15,"highRiskStopPct":10,"maxStopPct":40},"momentum_weakening_buyer_dominance_ratio":0.55}';
