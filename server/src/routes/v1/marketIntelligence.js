const express = require("express");
const controller = require("../../controllers/marketIntelligenceController");

const router = express.Router();

router.get("/trenches", controller.getTrenches);

router.get("/hot-searches", controller.getHotSearches);

router.get("/activity/kol", controller.getKolActivity);

router.get("/activity/smart-money", controller.getSmartMoneyActivity);

router.get("/gas-price", controller.getGasPrice);

router.get("/launchpad-stats", controller.getLaunchpadStats);

module.exports = router;
