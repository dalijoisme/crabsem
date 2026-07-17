// routes/index.js - mounts every API version. Only v1 exists today;
// a future v2 would get its own routes/v2/ and a second router.use()
// here, without touching v1.

const express = require("express");
const v1Routes = require("./v1");

const router = express.Router();

router.use("/v1", v1Routes);

module.exports = router;
