const express = require("express");
const controller = require("../../controllers/walletController");

const router = express.Router();

router.get("/wallets/search", controller.search);

router.get("/wallets/leaderboard", controller.leaderboard);

router.get("/wallets/:address", controller.getProfile);

module.exports = router;
