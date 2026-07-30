// services/strategyProfileTranslator.js - Strategy Profile refactor,
// the ONE place a profile's config gets translated into the three
// override groups the engine/gate/exit layers actually consume:
//   philosophy          -> researchEngineFactory.analyzeTokenWithPhilosophy
//                           (weights/tiers/... PLUS philosophy.acceleration,
//                           see acceleration_overrides below)
//   qualityGateOverrides -> qualityGateService.passesQualityGate
//   exitOverrides        -> productionEngineV2.buildRiskBands / tradePlanService.buildRiskBands / dynamicExitService.evaluateDynamicExit
//
// Used by BOTH consumers (predictionValidationService.js's single live
// decision log, and benchmarkRunner.js's per-distinct-profile fan-out)
// so profile->engine-parameter mapping logic lives in exactly one
// place - never duplicated between the live bot and the Benchmark
// Harness.
//
// Tolerant of both shapes a profile config can arrive in:
//   - benchmark_profiles.config_json, parsed: nested object fields
//     (e.g. `weights: {...}`) since the whole blob is free-form JSON.
//   - trading_bot_config, a real SQL row: the same nested concepts are
//     stored as separate `*_json` TEXT columns (e.g. `weights_json`).
// Every field is optional; an object with none of these keys set
// translates to {} on every override group, which is a strict no-op
// everywhere it's consumed (byte-identical to today's behavior).

function maybeParseJson(value){
    if(value == null) return null;
    if(typeof value === "object") return value;
    try{ return JSON.parse(value); } catch(e){ return null; }
}

function translate(config){

    const c = config || {};

    const weights = c.weights ?? maybeParseJson(c.weights_json) ?? {};
    const tiers = c.tiers ?? maybeParseJson(c.tiers_json) ?? {};
    const qualityGateOverrides = c.quality_gate_overrides ?? maybeParseJson(c.quality_gate_overrides_json) ?? {};
    const stopLoss = c.stop_loss_overrides ?? maybeParseJson(c.stop_loss_overrides_json) ?? null;
    // acceleration: absent/null on every profile except Aggressive today -
    // a strict no-op wherever it's consumed (see researchEngineFactory.js's
    // computeAccelerationSignal), same contract as every other override group.
    const acceleration = c.acceleration_overrides ?? maybeParseJson(c.acceleration_overrides_json) ?? null;

    const philosophy = {
        weights,
        tiers,
        minLiquidityUsd: c.min_liquidity_usd ?? null,
        minVolumeUsd: c.min_volume_usd ?? null,
        flattenEarliness: c.flatten_earliness != null ? Boolean(Number(c.flatten_earliness)) : true,
        smBonus: c.sm_bonus != null ? Boolean(Number(c.sm_bonus)) : false,
        acceleration
    };

    const exitOverrides = {
        fixedTpPct: c.fixed_tp_pct ?? 15,
        stopLoss,
        momentumWeakeningBuyerDominanceRatio: c.momentum_weakening_buyer_dominance_ratio ?? 0.5
    };

    return { philosophy, qualityGateOverrides, exitOverrides };

}

module.exports = { translate };
