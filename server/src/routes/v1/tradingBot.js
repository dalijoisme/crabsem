// routes/v1/tradingBot.js - Trading Bot Dashboard API.
//
// Sprint A, Goal 2 (auth/multi-tenancy foundation): gated by
// middleware/userAuth.js (X-Auth-Token, per-user), NOT middleware/adminAuth.js
// anymore - this is now a real, per-tenant, end-user-facing feature, not
// an admin-only single-bot dashboard. This swap lands in the same
// deploy as migration 035's schema change and tradingBotRepository.js's
// userId-scoping rewrite - swapping only the middleware without the
// per-user scoping underneath would force a login for zero tenancy
// benefit (every logged-in user would still poke the one global bot).

const express = require("express");
const controller = require("../../controllers/tradingBotController");
const userAuth = require("../../middleware/userAuth");

const router = express.Router();

router.use("/tradingbot", userAuth);

router.get("/tradingbot/status", controller.getStatus);

router.get("/tradingbot/config", controller.getConfig);
router.put("/tradingbot/config", controller.updateConfig);

// Trading Configuration sprint - separate from Strategy Profile
// (/config above): position sizing/max open positions are now
// Founder-controlled, independent of which AI profile is active.
router.get("/tradingbot/trading-configuration", controller.getTradingConfiguration);
router.put("/tradingbot/trading-configuration", controller.updateTradingConfiguration);

router.get("/tradingbot/decision-center", controller.getDecisionCenter);
router.get("/tradingbot/portfolio", controller.getPortfolio);
router.get("/tradingbot/positions", controller.getPositions);
router.get("/tradingbot/positions/:id", controller.getPositionDetail);
router.post("/tradingbot/positions/:id/sell", controller.sellPosition);
router.get("/tradingbot/trades", controller.getTrades);
router.get("/tradingbot/log", controller.getLog);
router.get("/tradingbot/equity-curve", controller.getEquityCurve);
router.get("/tradingbot/momentum-kpi", controller.getMomentumKpi);
router.get("/tradingbot/missed-winners", controller.getMissedWinners);
router.get("/tradingbot/self-audit", controller.getSelfAudit);
router.get("/tradingbot/system-throughput", controller.getSystemThroughput);
router.get("/tradingbot/bottleneck-report", controller.getBottleneckReport);
router.get("/tradingbot/target-achievement", controller.getTargetAchievementSummary);

router.post("/tradingbot/start", controller.start);
router.post("/tradingbot/stop", controller.stop);
router.post("/tradingbot/pause", controller.pause);
router.post("/tradingbot/mode", controller.setMode);
router.post("/tradingbot/force-sell-all", controller.forceSellAll);
router.post("/tradingbot/emergency-stop", controller.emergencyStop);

router.post("/tradingbot/custom-objective/analyze", controller.analyzeCustomObjective);

// CRAB User Journey v1 (locked) - Trading Allocation, percentage-based.
// requireVerifiedEmail (Phase 4) will gate this once it exists.
router.post("/tradingbot/allocation", controller.setAllocation);

// Reset Trading Capital (Founder-only, gated inside the service layer -
// see services/tradingBotService.js's resetTradingCapital()). Ledger-
// baseline reset only - never deletes trade/prediction/execution/
// benchmark history.
router.post("/tradingbot/reset-trading-capital", controller.resetTradingCapital);

module.exports = router;
