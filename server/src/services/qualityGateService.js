// services/qualityGateService.js - shared hard-reject Quality Gate,
// extracted from predictionValidationService.js so the SAME real,
// already-collected rug/manipulation checks can also gate the live
// homepage/trending recommendation surface (tokenQueryService.js),
// not just new decision-log rows. One set of thresholds, two callers -
// never two independently-drifting copies of "what counts as a rug".
//
// Thresholds are deliberately extreme (reject only the clearest
// cases) - unvalidated starting points, not final calibrated values.

const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");

const QUALITY_GATE = {
    maxRugRatio: 0.70,
    maxTop10HolderRate: 0.60,
    maxBundlerMhrWithLowLiquidity: 0.95,
    lowLiquidityThresholdUsd: 10000,
    minSerialCreatorCount: 500,
    maxSerialCreatorOpenRatio: 0.05
};

// overrides (Strategy Profile refactor, optional, trailing): a partial
// object shallow-merged over QUALITY_GATE. Omitted/absent - including
// every pre-existing caller that doesn't pass a 2nd argument at all -
// reproduces today's global thresholds exactly. These 5 thresholds are
// deliberately the ones made profile-tunable: they are soft, extreme-
// statistical-percentile filters (see file header), NOT the true binary
// hard-reject (that's scoringConfig.js's safetyVeto - honeypot/backing-
// ratio/min-holders - which stays global and is never touched here).
function passesQualityGate(token, overrides){
    const gate = overrides ? { ...QUALITY_GATE, ...overrides } : QUALITY_GATE;

    const trenches = gmgnTrenchesRepository.findByTokenAddress(token.token_address);
    if(!trenches) return { pass: true }; // no real data to reject on - never fabricate a rejection

    if(trenches.rug_ratio != null && Number(trenches.rug_ratio) > gate.maxRugRatio){
        return { pass: false, reason: "REJECTED_RUG_RATIO_EXTREME" };
    }
    if(trenches.top_10_holder_rate != null && Number(trenches.top_10_holder_rate) > gate.maxTop10HolderRate){
        return { pass: false, reason: "REJECTED_HOLDER_CONCENTRATION_EXTREME" };
    }

    let raw = {};
    try{ raw = JSON.parse(trenches.raw_json || "{}"); } catch(e){ /* real field parse failed - never guess, just skip these two checks */ }

    const liquidity = Number(token.liquidity) || 0;
    if(raw.bundler_mhr != null && Number(raw.bundler_mhr) > gate.maxBundlerMhrWithLowLiquidity && liquidity < gate.lowLiquidityThresholdUsd){
        return { pass: false, reason: "REJECTED_BUNDLER_MANIPULATION_EXTREME" };
    }
    if(raw.creator_created_count != null && Number(raw.creator_created_count) > gate.minSerialCreatorCount &&
       raw.creator_created_open_ratio != null && Number(raw.creator_created_open_ratio) < gate.maxSerialCreatorOpenRatio){
        return { pass: false, reason: "REJECTED_SERIAL_SCAM_CREATOR_PATTERN" };
    }

    return { pass: true };
}

module.exports = { QUALITY_GATE, passesQualityGate };
