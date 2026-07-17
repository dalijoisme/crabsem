const express = require("express");
const { listTokens, getTokenByAddress, getTrending } = require("../../controllers/tokensController");

const router = express.Router();

router.get("/tokens", listTokens);

router.get("/token/:address", getTokenByAddress);

router.get("/trending", getTrending);

module.exports = router;
