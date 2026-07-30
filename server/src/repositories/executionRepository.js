// repositories/executionRepository.js - the only file that touches
// executions/execution_log (migration 045_execution_layer.sql).
//
// Same split as trading_bot_positions (current state) vs
// trading_bot_log (append-only) in repositories/tradingBotRepository.js:
// `executions` is one row per attempted real transaction, overwritten
// in place as services/execution/executorStateMachine.js's states
// advance; `execution_log` is the append-only transition/error/RPC
// trail written by services/execution/executionLogger.js. Nothing in
// this file knows WHY a transition happened - it only persists
// whatever services/execution/executionService.js (the orchestrator)
// tells it to.
//
// forUser(userId) mirrors tradingBotRepository.js's own forUser() -
// the same DI seam services/tradeManager.js/entryGateService.js already
// use, so services/execution/executionService.js can be constructed
// with a per-user-scoped repository the exact same way.

const db = require("../database/connection");

const insertExecutionStmt = db.prepare(`
    INSERT INTO executions (user_id, wallet_public_key, token_address, action, amount_lamports, amount_usd)
    VALUES (@userId, @walletPublicKey, @tokenAddress, @action, @amountLamports, @amountUsd)
`);

function insertExecution(userId, { walletPublicKey, tokenAddress, action, amountLamports, amountUsd }){
    const info = insertExecutionStmt.run({
        userId,
        walletPublicKey,
        tokenAddress: tokenAddress ?? null,
        action,
        amountLamports: amountLamports ?? null,
        amountUsd: amountUsd ?? null
    });
    return info.lastInsertRowid;
}

function findById(userId, id){
    return db.prepare("SELECT * FROM executions WHERE id = ? AND user_id = ?").get(id, userId);
}

function findByUser(userId, limit){
    return db.prepare("SELECT * FROM executions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit || 100);
}

// Phase 2 (Live Validation & Bottleneck Elimination): real, already-
// recorded BUY execution failures within a rolling window - the
// Bottleneck Report's real "Execution Failed" count and the real latest
// error_message, never a guessed RPC/wallet-error split (see
// services/tradingBotService.js's own comment on why that split isn't
// invented).
function findFailedBuysSince(userId, hours){
    return db.prepare(`
        SELECT * FROM executions
        WHERE user_id = ? AND action = 'BUY' AND status IN ('FAILED', 'TIMEOUT')
          AND datetime(created_at) >= datetime('now', '-' || ? || ' hours')
        ORDER BY created_at DESC
    `).all(userId, hours);
}

// One non-terminal execution per user at a time - the service layer
// checks this BEFORE calling insertExecution (same "check, then insert"
// convention services/walletService.js's generateTradingWallet() already
// uses for trading_wallets' own 1:1-per-user constraint). The partial
// unique index in the migration is the defense-in-depth backstop, not
// the primary mechanism.
function findActiveByUser(userId){
    return db.prepare(
        "SELECT * FROM executions WHERE user_id = ? AND status NOT IN ('SUCCESS', 'FAILED', 'TIMEOUT')"
    ).get(userId);
}

// Global (not user-scoped) - services/execution/executionService.js's
// reconcilePendingExecutions() runs this once at boot across every
// user's rows, not just one user's. Deliberately not exposed through
// forUser() below, since it is never meant to be called per-user.
function findPendingWithTxHash(){
    return db.prepare(
        "SELECT * FROM executions WHERE status IN ('SUBMITTED', 'CONFIRMING') AND tx_hash IS NOT NULL"
    ).all();
}

// Single generic transition writer - the repository doesn't have a
// dedicated statement per state (PREPARING/SIGNING/...) because each
// transition only ever touches a handful of the same optional columns;
// executorStateMachine.js's onTransition hook already knows exactly
// which fields matter for a given transition and passes only those.
// COALESCE keeps every field not passed this call unchanged.
const transitionStmt = db.prepare(`
    UPDATE executions
    SET status = @status,
        blockhash = COALESCE(@blockhash, blockhash),
        last_valid_block_height = COALESCE(@lastValidBlockHeight, last_valid_block_height),
        tx_hash = COALESCE(@txHash, tx_hash),
        error_message = COALESCE(@errorMessage, error_message),
        confirmation_result_json = COALESCE(@confirmationResultJson, confirmation_result_json),
        completed_at = COALESCE(@completedAt, completed_at),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
`);

function transitionExecution(id, status, fields = {}){
    transitionStmt.run({
        id,
        status,
        blockhash: fields.blockhash ?? null,
        lastValidBlockHeight: fields.lastValidBlockHeight ?? null,
        txHash: fields.txHash ?? null,
        errorMessage: fields.errorMessage ?? null,
        confirmationResultJson: fields.confirmationResult ? JSON.stringify(fields.confirmationResult) : null,
        completedAt: fields.completed ? new Date().toISOString().slice(0, 19).replace("T", " ") : null
    });
}

const insertLogStmt = db.prepare(`
    INSERT INTO execution_log (execution_id, log_type, from_status, to_status, message, rpc_endpoint, latency_ms, meta_json)
    VALUES (@executionId, @logType, @fromStatus, @toStatus, @message, @rpcEndpoint, @latencyMs, @metaJson)
`);

function insertLog(executionId, { logType, fromStatus, toStatus, message, rpcEndpoint, latencyMs, meta }){
    insertLogStmt.run({
        executionId,
        logType,
        fromStatus: fromStatus ?? null,
        toStatus: toStatus ?? null,
        message: message ?? null,
        rpcEndpoint: rpcEndpoint ?? null,
        latencyMs: latencyMs ?? null,
        metaJson: meta ? JSON.stringify(meta) : null
    });
}

function findLogByExecutionId(executionId){
    return db.prepare("SELECT * FROM execution_log WHERE execution_id = ? ORDER BY created_at ASC, id ASC").all(executionId);
}

// The shared-shape view services/execution/executionService.js
// actually consumes - same pattern as tradingBotRepository.js's own
// forUser(): every method is the module-level function with `userId`
// already partially applied via closure. transitionExecution/insertLog/
// findLogByExecutionId operate on an execution/log id, not a userId,
// so (like updatePositionTracking in tradingBotRepository.js) they're
// exposed unscoped.
function forUser(userId){
    return {
        insertExecution: (row) => insertExecution(userId, row),
        findById: (id) => findById(userId, id),
        findByUser: (limit) => findByUser(userId, limit),
        findActiveByUser: () => findActiveByUser(userId),
        transitionExecution,
        insertLog,
        findLogByExecutionId
    };
}

module.exports = {
    insertExecution, findById, findByUser, findActiveByUser, findPendingWithTxHash, findFailedBuysSince,
    transitionExecution,
    insertLog, findLogByExecutionId,
    forUser
};
