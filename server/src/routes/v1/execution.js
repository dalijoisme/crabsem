// routes/v1/execution.js - Execution Layer foundation (Sprint 1). Read-only
// history/detail/log plus a real on-chain balance check - deliberately no
// route reaches executionService.execute() this sprint (see
// controllers/executionController.js's header for why).

const express = require("express");
const controller = require("../../controllers/executionController");
const userAuth = require("../../middleware/userAuth");

const router = express.Router();

router.use("/execution", userAuth);

router.get("/execution", controller.list);
router.get("/execution/:id", controller.getOne);
router.get("/execution/:id/log", controller.getLog);
router.post("/execution/balance/check", controller.checkBalance);

module.exports = router;
