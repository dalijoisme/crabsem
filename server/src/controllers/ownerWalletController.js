// controllers/ownerWalletController.js - thin HTTP layer for Owner
// Wallet / Trading Wallet (CRAB User Journey v1). Named distinctly
// from the existing controllers/walletController.js, which backs the
// unrelated CRABSEM holder-wallet lookup feature (routes/v1/wallets.js,
// plural) - this file is singular /wallet/* routes, a completely
// different domain. Every handler reads req.user.id (attached by
// middleware/userAuth.js) - every action operates on THIS caller's own
// wallets, never a global/shared one.

const walletService = require("../services/walletService");
const { sendSuccess, sendError } = require("../utils/apiResponse");

async function connect(req, res, next){
    try{
        const { walletAddress } = req.body || {};
        const result = walletService.connectWallet(req.user.id, walletAddress);
        if(!result.ok) return sendError(res, result.status, result.error, result.details);
        sendSuccess(res, { connected: true });
    }
    catch(err){ next(err); }
}

async function challenge(req, res, next){
    try{
        sendSuccess(res, walletService.issueOwnershipChallenge(req.user.id));
    }
    catch(err){ next(err); }
}

async function verify(req, res, next){
    try{
        const { message, checksum, signature } = req.body || {};
        const result = walletService.verifyOwnership(req.user.id, { message, checksum, signature });
        if(!result.ok) return sendError(res, result.status, result.error, result.details);
        sendSuccess(res, { verified: true });
    }
    catch(err){ next(err); }
}

async function generateTradingWallet(req, res, next){
    try{
        const result = walletService.generateTradingWallet(req.user.id);
        if(!result.ok) return sendError(res, result.status, result.error, result.details);
        sendSuccess(res, { publicKey: result.publicKey });
    }
    catch(err){ next(err); }
}

async function status(req, res, next){
    try{
        sendSuccess(res, walletService.getStatus(req.user.id));
    }
    catch(err){ next(err); }
}

async function deposit(req, res, next){
    try{
        const { amountUsd } = req.body || {};
        const result = walletService.depositFunds(req.user.id, amountUsd);
        if(!result.ok) return sendError(res, result.status, result.error, result.details);
        sendSuccess(res, { depositedBalanceUsd: result.depositedBalanceUsd });
    }
    catch(err){ next(err); }
}

async function withdraw(req, res, next){
    try{
        const { amountUsd } = req.body || {};
        const result = walletService.withdrawFunds(req.user.id, amountUsd);
        if(!result.ok) return sendError(res, result.status, result.error, result.details);
        sendSuccess(res, { depositedBalanceUsd: result.depositedBalanceUsd });
    }
    catch(err){ next(err); }
}

module.exports = { connect, challenge, verify, generateTradingWallet, status, deposit, withdraw };
