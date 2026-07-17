// routes/v1/index.js - aggregates every v1 resource route. Mounted
// at /v1 by routes/index.js, which itself is mounted at /api by
// app.js, giving the full /api/v1/... paths.

const express = require("express");
const healthRoutes = require("./health");
const tokensRoutes = require("./tokens");
const statsRoutes = require("./stats");
const searchRoutes = require("./search");
const marketIntelligenceRoutes = require("./marketIntelligence");
const gmgnOndemandRoutes = require("./gmgnOndemand");
const validationRoutes = require("./validation");

const router = express.Router();

router.use(healthRoutes);
router.use(tokensRoutes);
router.use(statsRoutes);
router.use(searchRoutes);
router.use(marketIntelligenceRoutes);
router.use(gmgnOndemandRoutes);
router.use(validationRoutes);

module.exports = router;
