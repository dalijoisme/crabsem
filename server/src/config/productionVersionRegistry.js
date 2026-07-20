// config/productionVersionRegistry.js - permanent, versioned record of every
// production engine this project has ever run or considered. This is the
// ONLY place that decides which engine actually drives real predictions -
// change ACTIVE_VERSION (and nothing else) to promote or roll back.
//
// Rollback procedure: set ACTIVE_VERSION back to "production_v1" and restart
// the server. No code changes required - productionEngineResolver.js reads
// this file at require-time on every process start.
//
// Production_V1 (intelligenceEngine.js + scoringConfig.js) is NEVER modified,
// renamed, or deleted by adding new versions here - it remains fully
// executable and independently requireable at all times.

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

        status: "ACTIVE",

        engineShortName: "Momentum Hunter",

        exitStrategyShortName: "Fixed TP15",

        engine: "Momentum Hunter (server/src/services/researchEngineFactory.js, philosophy key 'momentumHunter')",

        exitStrategy: "Fixed Take Profit 15% (native dynamic Stop Loss retained)",

        description: "Validated successor after the Engine League tournament (6 hours, 24 philosophies x 8 exit strategies, 192 shadow portfolios) and the Real Capital Validation Tournament (1 hour, cash-constrained real-account model, 1%/1% buy/sell fees, no leverage). See server/research-archive/ for the full, permanently-archived data behind this decision.",

        rollback: true,

        purpose: "Default production engine",

        promotedAt: "2026-07-20",

        retiredAt: null,

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

    }

};

// THE SWITCH. Change this one value to roll back or roll forward. Must be a
// key that exists in REGISTRY above.
const ACTIVE_VERSION = "production_v2";

module.exports = { REGISTRY, ACTIVE_VERSION };
