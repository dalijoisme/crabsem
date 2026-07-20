// services/productionEngineResolver.js - the ONE indirection point between
// the real prediction-creation pipeline (predictionValidationService.js) and
// whichever production engine version is currently active. Reads
// config/productionVersionRegistry.js at require-time; switching versions
// requires editing ONLY that registry's ACTIVE_VERSION field, then
// restarting the process - no code changes anywhere else.

const { REGISTRY, ACTIVE_VERSION } = require("../config/productionVersionRegistry");
const productionV1 = require("./intelligenceEngine");
const productionV2 = require("./productionEngineV2");
const tradePlanService = require("./tradePlanService");

// Each entry pairs a scoring engine with its matched trade-plan builder, so
// callers get one consistent object regardless of which version is active.
const ENGINES = {

    production_v1: {
        analyzeTokens: productionV1.analyzeTokens,
        analyzeToken: productionV1.analyzeToken,
        buildRiskBands: tradePlanService.buildRiskBands
    },

    production_v2: {
        analyzeTokens: productionV2.analyzeTokens,
        analyzeToken: productionV2.analyzeToken,
        buildRiskBands: productionV2.buildRiskBands
    }

};

function getActiveVersion(){

    return ACTIVE_VERSION;

}

function getActiveEngine(){

    const engine = ENGINES[ACTIVE_VERSION];

    if(!engine){

        throw new Error(`productionEngineResolver: unknown ACTIVE_VERSION "${ACTIVE_VERSION}" in config/productionVersionRegistry.js - must be one of: ${Object.keys(ENGINES).join(", ")}`);

    }

    return engine;

}

module.exports = { getActiveEngine, getActiveVersion, REGISTRY };
