// routes/v1/auth.js - Sprint A, Goal 2 + Auth & Onboarding sprint. User
// authentication for the trading bot domain - fully separate from
// routes/v1/admin.js's ADMIN_PASSWORD system. Same "login route
// registered before the auth gate" pattern as admin.js: you need to
// log in before you can have a token to be gated by. Register/
// verify-email/forgot-password/reset-password are all pre-token
// routes for the same reason login is.

const express = require("express");
const controller = require("../../controllers/authController");
const userAuth = require("../../middleware/userAuth");

const router = express.Router();

router.post("/auth/register", controller.register);
router.post("/auth/login", controller.login);
router.post("/auth/logout", userAuth, controller.logout);
router.post("/auth/verify-email", controller.verifyEmail);
router.post("/auth/resend-verification", userAuth, controller.resendVerification);
router.post("/auth/forgot-password", controller.forgotPassword);
router.post("/auth/reset-password", controller.resetPassword);

module.exports = router;
