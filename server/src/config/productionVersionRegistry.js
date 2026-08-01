// config/productionVersionRegistry.js - permanent, versioned record of every
// production engine this project has ever run or considered. This is the
// ONLY place that decides which engine actually drives real predictions -
// change ACTIVE_VERSION (and nothing else) to promote or roll back.
//
// Rollback procedure: set ACTIVE_VERSION back to "production_v2" (the
// previous ACTIVE version - Momentum Hunter, unchanged) and restart the
// server. No code changes required - productionEngineResolver.js reads
// this file at require-time on every process start. A further rollback to
// "production_v1" remains available the same way if ever needed.
//
// Production_V1 (intelligenceEngine.js + scoringConfig.js) and Production_V2
// (productionEngineV2.js) are NEVER modified, renamed, or deleted by adding
// new versions here - both remain fully executable and independently
// requireable at all times. decision_engine_v2 (below) WRAPS production_v2
// unchanged at its scoring layer (services/decisionEngineV2Adapter.js) - it
// does not fork or replace productionEngineV2.js's own logic.

const REGISTRY = {

    production_v1: {

        status: "LEGACY",

        engineShortName: "Original Production",

        exitStrategyShortName: "Native Dynamic",

        engine: "Original Production (server/src/services/intelligenceEngine.js, unmodified)",

        exitStrategy: "Native Dynamic (per-signal target/stop from server/src/services/tradePlanService.js)",

        description: "Original conservative production engine - participant/market weighted scoring with an earliness discount on momentum that has already moved.",

        rollback: true,

        purpose: "Rollback candidate",

        promotedAt: null,

        retiredAt: "2026-07-20"

    },

    production_v2: {

        status: "LEGACY",

        engineShortName: "Momentum Hunter",

        exitStrategyShortName: "Fixed TP15",

        engine: "Momentum Hunter (server/src/services/researchEngineFactory.js, philosophy key 'momentumHunter')",

        exitStrategy: "Fixed Take Profit 15% (native dynamic Stop Loss retained)",

        description: "Validated successor after the Engine League tournament (6 hours, 24 philosophies x 8 exit strategies, 192 shadow portfolios) and the Real Capital Validation Tournament (1 hour, cash-constrained real-account model, 1%/1% buy/sell fees, no leverage). See server/research-archive/ for the full, permanently-archived data behind this decision. Superseded by decision_engine_v2 below, which wraps this exact engine unchanged at its scoring layer - retained here, fully executable, as the immediate rollback target.",

        rollback: true,

        purpose: "Rollback candidate",

        promotedAt: "2026-07-20",

        retiredAt: "2026-08-01",

        // Documented for reference/consistency with the validated tournament
        // configuration. NOT wired to a live trade executor - CRAB AGENT's
        // current architecture generates recommendations and a trade plan
        // (target/stop), it does not itself execute real trades, so these
        // fields describe the validated simulation config rather than an
        // active position-sizing mechanism in production today.
        referenceConfig: {

            initialCapital: 100,

            positionSizePctOfCash: 0.20,

            maxPositionSizeUsd: 100,

            maxOpenPositions: 5,

            onePositionPerToken: true,

            buyFeePct: 0.01,

            sellFeePct: 0.01,

            slippagePct: 0.01,

            mode: "LIVE"

        }

    },

    decision_engine_v2: {

        status: "ACTIVE",

        engineShortName: "Decision Engine V2 (Data-Driven)",

        exitStrategyShortName: "Fixed TP15",

        engine: "Momentum Hunter scoring (server/src/services/productionEngineV2.js, unchanged) wrapped by server/src/services/decisionEngineV2.js's 5-layer historical-adjustment via server/src/services/decisionEngineV2Adapter.js.",

        exitStrategy: "Fixed Take Profit 15% (native dynamic Stop Loss retained) - identical to production_v2, buildRiskBands is a pure passthrough, never touched by Decision Engine V2.",

        description: "Feature -> Historical Success -> BUY/HOLD: action/confidence from production_v2's own scoring (Layer 1, byte-identical) are blended with this exact feature combination's REAL historical win rate/avg ROI from trading_bot_trades (Layers 2-4, server/src/config/decisionEngineV2Config.js's configurable weights), then can only ever DOWNGRADE a BUY to HOLD when history says the combination loses (Layer 5) - never upgrade. Sample-gated: below 5 historical trades for a combination, historical is ignored entirely and this is byte-identical to production_v2's own decision. See server/src/services/decisionEngineV2.js/decisionEngineV2Adapter.js for the full design and server/src/services/decisionEngineV2.test.js for verified behavior.",

        rollback: true,

        purpose: "Default production engine",

        promotedAt: "2026-08-01",

        retiredAt: null

    }

};

// THE SWITCH. Change this one value to roll back or roll forward. Must be a
// key that exists in REGISTRY above.
const ACTIVE_VERSION = "decision_engine_v2";

module.exports = { REGISTRY, ACTIVE_VERSION };
