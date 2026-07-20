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

function passesQualityGate(token){
    const trenches = gmgnTrenchesRepository.findByTokenAddress(token.token_address);
    if(!trenches) return { pass: true }; // no real data to reject on - never fabricate a rejection

    if(trenches.rug_ratio != null && Number(trenches.rug_ratio) > QUALITY_GATE.maxRugRatio){
        return { pass: false, reason: "REJECTED_RUG_RATIO_EXTREME" };
    }
    if(trenches.top_10_holder_rate != null && Number(trenches.top_10_holder_rate) > QUALITY_GATE.maxTop10HolderRate){
        return { pass: false, reason: "REJECTED_HOLDER_CONCENTRATION_EXTREME" };
    }

    let raw = {};
    try{ raw = JSON.parse(trenches.raw_json || "{}"); } catch(e){ /* real field parse failed - never guess, just skip these two checks */ }

    const liquidity = Number(token.liquidity) || 0;
    if(raw.bundler_mhr != null && Number(raw.bundler_mhr) > QUALITY_GATE.maxBundlerMhrWithLowLiquidity && liquidity < QUALITY_GATE.lowLiquidityThresholdUsd){
        return { pass: false, reason: "REJECTED_BUNDLER_MANIPULATION_EXTREME" };
    }
    if(raw.creator_created_count != null && Number(raw.creator_created_count) > QUALITY_GATE.minSerialCreatorCount &&
       raw.creator_created_open_ratio != null && Number(raw.creator_created_open_ratio) < QUALITY_GATE.maxSerialCreatorOpenRatio){
        return { pass: false, reason: "REJECTED_SERIAL_SCAM_CREATOR_PATTERN" };
    }

    return { pass: true };
}

module.exports = { QUALITY_GATE, passesQualityGate };
