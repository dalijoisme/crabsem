const express = require("express");
const controller = require("../../controllers/validationController");

const router = express.Router();

router.get("/validation/summary", controller.getSummary);

module.exports = router;
