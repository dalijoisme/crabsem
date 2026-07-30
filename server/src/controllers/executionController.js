// controllers/executionController.js - thin HTTP layer for the
// Execution Layer foundation (Sprint 1). Deliberately READ-ONLY plus a
// real on-chain balance check - no route here can reach
// executionService.execute(), so nothing this sprint lets an API
// caller move funds (see services/execution/executionService.js's
// header for why). Sprint 2 adds whatever route actually triggers a
// real BUY/SELL.

const config = require("../config/env");
const { executionRepository, tradingWalletRepository, balanceService } = require("../services/execution");
const { sendSuccess, sendError } = require("../utils/apiResponse");

async function list(req, res, next){
    try{ sendSuccess(res, executionRepository.findByUser(req.user.id, Number(req.query.limit) || 100)); }
    catch(err){ next(err); }
}

async function getOne(req, res, next){
    try{
        const execution = executionRepository.findById(req.user.id, Number(req.params.id));
        if(!execution) return sendError(res, 404, "Not found", "No execution with that id for this account.");
        sendSuccess(res, execution);
    }
    catch(err){ next(err); }
}

async function getLog(req, res, next){
    try{
        const execution = executionRepository.findById(req.user.id, Number(req.params.id));
        if(!execution) return sendError(res, 404, "Not found", "No execution with that id for this account.");
        sendSuccess(res, executionRepository.findLogByExecutionId(execution.id));
    }
    catch(err){ next(err); }
}

// Real on-chain read, never a client-supplied number (see
// services/execution/balanceValidationService.js's header) - the fix
// for the gap the earlier migration audit flagged in
// services/walletService.js's depositFunds().
async function checkBalance(req, res, next){
    try{

        if(!config.SOLANA_RPC_URL){
            return sendError(res, 503, "Execution layer disabled", "SOLANA_RPC_URL is not configured on the server.");
        }

        const wallet = tradingWalletRepository.findByUserId(req.user.id);
        if(!wallet){
            return sendError(res, 403, "Forbidden", "Generate a Trading Wallet before checking its balance.");
        }

        const solLamports = await balanceService.getNativeSolBalanceLamports(wallet.public_key);
        const result = { publicKey: wallet.public_key, solLamports };

        const { mintAddress } = req.body || {};
        if(mintAddress){
            result.token = await balanceService.getSplTokenBalance(wallet.public_key, mintAddress);
        }

        sendSuccess(res, result);

    }
    catch(err){ next(err); }
}

module.exports = { list, getOne, getLog, checkBalance };
