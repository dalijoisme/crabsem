// routes/v1/benchmark.js - Benchmark Harness Admin API. Same auth
// convention as every other admin surface (X-Admin-Key, see
// middleware/adminAuth.js) - no separate auth system.

const express = require("express");
const controller = require("../../controllers/benchmarkController");
const adminAuth = require("../../middleware/adminAuth");

const router = express.Router();

router.use("/benchmark", adminAuth);

router.get("/benchmark/profiles", controller.listProfiles);
router.post("/benchmark/profiles", controller.createProfile);

router.get("/benchmark/runs", controller.listRuns);
router.post("/benchmark/runs/start", controller.startRun);
router.get("/benchmark/runs/:id", controller.getRun);
router.post("/benchmark/runs/:id/pause", controller.pauseRun);
router.post("/benchmark/runs/:id/resume", controller.resumeRun);
router.post("/benchmark/runs/:id/stop", controller.stopRun);

router.get("/benchmark/runs/:id/positions", controller.getRunPositions);
router.get("/benchmark/runs/:id/statistics", controller.getRunStatistics);
router.get("/benchmark/runs/:id/report", controller.getRunReport);

router.get("/benchmark/health", controller.getHealth);

module.exports = router;
