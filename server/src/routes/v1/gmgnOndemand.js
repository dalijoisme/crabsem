// routes/v1/gmgnOndemand.js - on-demand per-token/per-wallet GMGN
// lookups, cached (see services/gmgnOndemandService.js).

const express = require("express");
const controller = require("../../controllers/gmgnIntelligenceController");

const router = express.Router();

router.get("/gmgn/token/:address/security", controller.getTokenSecurity);

router.get("/gmgn/token/:address/pool", controller.getTokenPoolInfo);

router.get("/gmgn/token/:address/holders", controller.getTokenTopHolders);

router.get("/gmgn/token/:address/traders", controller.getTokenTopTraders);

router.get("/gmgn/token/:address/kline", controller.getTokenKline);

router.get("/gmgn/wallet/:address/activity", controller.getWalletActivity);

router.get("/gmgn/wallet/:address/stats", controller.getWalletStats);

router.get("/gmgn/wallet/:address/holdings", controller.getWalletHoldings);

router.get("/gmgn/wallet/:address/created-tokens", controller.getCreatedTokens);

router.get("/gmgn/wallet/:address/balance/:tokenAddress", controller.getWalletTokenBalance);

module.exports = router;
