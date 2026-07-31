// routes/v1/wallet.js - Owner Wallet / Trading Wallet (CRAB User
// Journey v1). Singular "wallet" - distinct from the existing plural
// routes/v1/wallets.js (unrelated CRABSEM holder-wallet lookup
// feature). Behind middleware/userAuth.js throughout - every action
// operates on the caller's own wallets only.
//
// requireVerifiedEmail (Phase 4) will gate generate - not wired yet,
// service-layer preconditions (Owner Wallet verified, Trading Wallet
// exists) already enforce real ordering independent of that gate.
//
// Production Stabilization V1 (Sections D/E/Q): the deposit/withdraw
// routes are removed - there is no app-side "deposit" ledger action
// anymore (a real SOL deposit/withdrawal happens on-chain and is
// reflected automatically by GET /wallet/status's real balance fields).

const express = require("express");
const controller = require("../../controllers/ownerWalletController");
const userAuth = require("../../middleware/userAuth");

const router = express.Router();

router.use("/wallet", userAuth);

router.post("/wallet/connect", controller.connect);
router.get("/wallet/challenge", controller.challenge);
router.post("/wallet/verify", controller.verify);
router.post("/wallet/trading-wallet/generate", controller.generateTradingWallet);
router.get("/wallet/status", controller.status);

module.exports = router;
