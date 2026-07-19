// routes/v1/admin.js - every route here requires the X-Admin-Key
// header (see middleware/adminAuth.js), applied once at the router
// level so no individual handler can accidentally be left unguarded.
//
// Wallet search/leaderboard and prediction-metric detail are
// deliberately NOT duplicated here - they're already public,
// read-only endpoints (/api/v1/wallets/search, /wallets/leaderboard,
// /validation/summary) that the Admin Panel calls directly, so this
// file only adds what doesn't already exist: system internals, wallet
// label aggregates, engine config readout, and token admin actions.

const express = require("express");
const controller = require("../../controllers/adminController");
const ceoController = require("../../controllers/ceoDashboardController");
const learnController = require("../../controllers/learnController");
const adminAuth = require("../../middleware/adminAuth");

const router = express.Router();

// POST /admin/login is the one admin route that must NOT be gated -
// you need to log in before you have a token to be gated by. It is
// registered BEFORE the router.use(adminAuth) gate below, which only
// applies to routes registered after it.

router.post("/admin/login", controller.login);

router.use("/admin", adminAuth);

router.get("/admin/dashboard", controller.getDashboard);
router.get("/admin/system", controller.getSystem);
router.get("/admin/wallets/summary", controller.getWalletsSummary);
router.get("/admin/engine/config", controller.getEngineConfig);
router.get("/admin/predictions/summary", controller.getPredictionSummary);

router.post("/admin/tokens/:address/refresh", controller.refreshToken);
router.post("/admin/tokens/:address/reanalyze", controller.reanalyzeToken);
router.delete("/admin/tokens/:address/cache", controller.deleteTokenCache);

// Business-facing analytics (formerly a separate "CEO Dashboard" page -
// Admin V3 merged that page into admin.html/js/admin.js; the backend
// route prefix "/admin/ceo/*" is kept as-is, unrenamed, per Admin V3's
// own "don't rename existing endpoints" rule - it's an internal path,
// not a user-facing concept, and every one of these already works).
// See services/ceoDashboardService.js.

router.get("/admin/ceo/engine-status", ceoController.getEngineStatus);
router.get("/admin/ceo/signal-summary", ceoController.getSignalSummary);
router.get("/admin/ceo/result-summary", ceoController.getResultSummary);
router.get("/admin/ceo/strong-buy", ceoController.getStrongBuyAnalysis);
router.get("/admin/ceo/failure-analysis", ceoController.getFailureAnalysis);
router.get("/admin/ceo/wallet-performance", ceoController.getWalletPerformance);
router.get("/admin/ceo/wallet-categories", ceoController.getWalletCategories);
router.get("/admin/ceo/recommendations", ceoController.getRecommendations);
router.get("/admin/ceo/engine-advisor", ceoController.getEngineAdvisor);
router.get("/admin/ceo/ai-health", ceoController.getAiHealth);
router.get("/admin/ceo/engine-history", ceoController.getEngineHistory);
router.get("/admin/ceo/export", ceoController.exportTable);

// Learn System (Product Improvement Sprint, Part 7).
router.get("/admin/learn/summary", learnController.getSummary);

module.exports = router;
