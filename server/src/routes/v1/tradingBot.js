// routes/v1/tradingBot.js - Trading Bot Dashboard API. Every route here
// requires the same X-Admin-Key header as the rest of the Admin Panel
// (see middleware/adminAuth.js) - no separate auth system, reuses the
// existing admin login/session mechanism entirely.

const express = require("express");
const controller = require("../../controllers/tradingBotController");
const adminAuth = require("../../middleware/adminAuth");

const router = express.Router();

router.use("/tradingbot", adminAuth);

router.get("/tradingbot/status", controller.getStatus);

router.get("/tradingbot/config", controller.getConfig);
router.put("/tradingbot/config", controller.updateConfig);

router.get("/tradingbot/portfolio", controller.getPortfolio);
router.get("/tradingbot/positions", controller.getPositions);
router.get("/tradingbot/trades", controller.getTrades);
router.get("/tradingbot/log", controller.getLog);

router.post("/tradingbot/start", controller.start);
router.post("/tradingbot/stop", controller.stop);
router.post("/tradingbot/pause", controller.pause);
router.post("/tradingbot/force-sell-all", controller.forceSellAll);
router.post("/tradingbot/emergency-stop", controller.emergencyStop);

module.exports = router;
