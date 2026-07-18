// routes/v1/predictionValidation.js - the AI Validation Framework's
// public read endpoints (engine-quality sprint 3, Part 5).
//
// NAMESPACING NOTE (deliberate deviation from the literal spec paths,
// disclosed here and in the final report): the brief asked for
// GET /validation/summary, /validation/strong-buy, /validation/history,
// /validation/statistics. /api/v1/validation/summary ALREADY EXISTS
// (routes/v1/validation.js -> validationController.getSummary, backed
// by Sprint 2's recommendation_log/recommendation_outcomes framework -
// still live, still used internally by the Admin Panel). Silently
// replacing that route's behavior would break existing, working
// functionality with no warning; mounting a second, colliding handler
// on the exact same path is not possible in Express. These are
// therefore namespaced under /validation/predictions/* instead - a
// real, working, fully distinct set of endpoints for the NEW
// prediction_history-based framework, not a placeholder and not a
// silent rename of the old one.

const express = require("express");
const controller = require("../../controllers/predictionValidationController");

const router = express.Router();

router.get("/validation/predictions/summary", controller.getSummary);
router.get("/validation/predictions/strong-buy", controller.getStrongBuy);
router.get("/validation/predictions/history", controller.getHistory);
router.get("/validation/predictions/statistics", controller.getStatistics);
router.get("/validation/predictions/:id", controller.getOne);

module.exports = router;
