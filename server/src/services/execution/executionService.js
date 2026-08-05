// services/execution/executionService.js - the orchestrator, and the
// ONLY module that sequences states. Every other execution-layer module
// is a narrow specialist (sign, check balance, poll for confirmation,
// persist, log) injected here as a constructor dependency - same DI
// shape as services/tradeManager.js's createTradeManager(repository) /
// services/entryGateService.js's createEntryGateService(repository),
// just with more named collaborators since this service coordinates
// real chain I/O, not only the database.
//
// Arjuna V4 (Sprint 11), Part 1: the gap Production Hotfix V1.1, Section
// 6 documented and deliberately deferred is now fixed. Once a real
// transaction confirms SUCCESS, balanceReader.readActualSwapAmounts()
// (transactionBalanceReader.js) reads the confirmed transaction's own
// real pre/post SOL and SPL-token balances for the trading wallet - the
// actual thing that moved on-chain - and execute() returns them
// alongside txHash. tradeManager.js uses these (never token.price) as
// the official actual_sol_spent/actual_sol_received for a LIVE trade -
// see services/roiCalculator.js. Fails soft: if this read itself errors
// (RPC hiccup, index lag), the real swap already succeeded regardless -
// execute() still returns SUCCESS with actualAmounts: null, never fails
// an otherwise-successful trade over an observability read.
//
// `transactionBuilder` is the Sprint 2 seam: this file never builds a
// transaction itself, only calls transactionBuilder.build(...) and
// signs/submits whatever comes back. Sprint 1 injects
// selfTransferTransactionBuilder.js (a harmless test transaction) so
// the full pipeline can be proven end-to-end without any actual BUY/
// SELL/swap logic.
//
// CUSTODY MODEL ADAPTATION (Sprint 2, Founder Decision - Path A):
// gmgnSwapTransactionBuilder.js's build() can return one of two shapes:
//   - a real Transaction/VersionedTransaction (selfTransferTransactionBuilder.js,
//     and any future locally-signed provider) - signed here via
//     signingService, broadcast here via connectionProvider, exactly as
//     before, unchanged.
//   - a { __custodialExecution: true, submit } marker (gmgnSwapTransactionBuilder.js) -
//     GMGN signs and broadcasts server-side (confirmed from GMGN's own
//     official reference implementation - see that file's header for
//     the evidence). For this shape, the local SIGNING step is skipped
//     entirely (there is nothing local to sign) and the SUBMITTING step
//     calls submit() instead of sendRawTransaction() - submit() is the
//     one real, irreversible network call, deliberately deferred this
//     far so PREPARING can still safely fail/retry with nothing
//     submitted yet, preserving the exact crash-safety semantics this
//     state machine was built around.
// transactionSigningService.js is unchanged either way - it simply
// isn't called on the custodial path.
//
// NOT wired into any HTTP route this sprint (see routes/v1/execution.js) -
// execute() is only ever called by the test suite and the manual devnet
// script (scripts/manualExecutionSmokeTest.js), so nothing this sprint
// lets an API caller move real funds.

const { createExecutorStateMachine, STATES } = require("./executorStateMachine");
const { PublicKey } = require("@solana/web3.js");

// A transaction with 0 lamports of balance can never even pay its own
// network fee - checking balance against amountLamports alone (0 by
// default this sprint) would always "pass" even for an empty wallet.
// This buffer is Solana's own typical base fee order of magnitude, not
// a guess at what any particular transaction will cost - Sprint 2's
// real swap builder will have its own, more precise fee estimate to
// layer on top of this floor.
const MIN_FEE_BUFFER_LAMPORTS = 5000;

/**
 * @typedef {object} ExecutionServiceDeps
 * @property {typeof import("../../repositories/executionRepository")} repository - the RAW module (userId-taking functions), not a forUser()-scoped view: execute() serves any user by passing userId explicitly per call, and reconcilePendingExecutions() needs the global, cross-user findPendingWithTxHash() that forUser() deliberately doesn't expose - one instance of this service needs both.
 * @property {import("./solanaConnectionProvider").SolanaConnectionProvider} connectionProvider
 * @property {ReturnType<import("./transactionSigningService").createTransactionSigningService>} signingService
 * @property {ReturnType<import("./balanceValidationService").createBalanceValidationService>} balanceService
 * @property {ReturnType<import("./transactionConfirmationService").createTransactionConfirmationService>} confirmationService
 * @property {import("./selfTransferTransactionBuilder").TransactionBuilder} transactionBuilder
 * @property {ReturnType<import("./executionLogger").createExecutionLogger>} logger
 * @property {ReturnType<import("./transactionBalanceReader").createTransactionBalanceReader>} [balanceReader] - Arjuna V4, Part 1. Optional (defaults to a no-op reader) so every existing test-double caller that doesn't supply one keeps working unchanged.
 */

/**
 * @param {ExecutionServiceDeps} deps
 */
function createExecutionService({ repository, connectionProvider, signingService, balanceService, confirmationService, transactionBuilder, logger, balanceReader = { readActualSwapAmounts: async () => null } }){

    function buildMachine(executionId, initialState){
        return createExecutorStateMachine({
            initialState,
            onTransition(from, to, meta){
                repository.transitionExecution(executionId, to, meta || {});
                logger.logTransition(executionId, from, to, meta || {});
            }
        });
    }

    /**
     * @param {object} params
     * @param {number} params.userId
     * @param {string} params.walletPublicKey
     * @param {string} params.action - opaque to this file; only transactionBuilder interprets it
     * @param {number|null} [params.amountLamports]
     * @param {string|null} [params.tokenAddress]
     * @returns {Promise<{ executionId: number, outcome: import("./executorStateMachine").ExecutionState }>}
     */
    async function execute({ userId, walletPublicKey, action, amountLamports = null, tokenAddress = null }){

        const active = repository.findActiveByUser(userId);
        if(active){
            throw new Error(`executionService: user ${userId} already has an active execution (#${active.id}, status ${active.status}) - only one at a time`);
        }

        const executionId = repository.insertExecution(userId, { walletPublicKey, action, amountLamports, tokenAddress });
        const machine = buildMachine(executionId, STATES.IDLE);

        let signature;
        let preparedTransaction;
        let preparedLastValidBlockHeight;
        let isCustodialExecution = false;

        // ---- PREPARING: validate real balance, fetch a fresh blockhash, build the transaction ----
        try{

            machine.transition(STATES.PREPARING);

            // amountLamports is intentionally overloaded (see
            // gmgnSwapTransactionBuilder.js's own build() doc comment):
            // SOL lamports to spend for BUY, but the TOKEN's own raw
            // base-unit balance for SELL - a SELL spends the token, never
            // SOL, for the swapped amount itself. Only ever fold it into
            // the required-SOL floor for BUY; every action still needs at
            // least the network-fee buffer.
            const requiredLamports = (action === "BUY" ? (amountLamports ?? 0) : 0) + MIN_FEE_BUFFER_LAMPORTS;
            const sufficient = await balanceService.hasSufficientSolBalance(walletPublicKey, requiredLamports);
            if(!sufficient){
                throw new Error(`insufficient on-chain SOL balance for wallet ${walletPublicKey} (need at least ${requiredLamports} lamports)`);
            }

            const connection = connectionProvider.getConnection();
            const latestBlockhash = await connection.getLatestBlockhash();

            const transaction = await transactionBuilder.build({ userId, walletPublicKey, action, amountLamports, tokenAddress });

            // A custodial-execution marker (see this file's header) has
            // no local Transaction fields to fill in - GMGN builds its
            // own transaction server-side, using its own fresh blockhash
            // at submit time. The blockhash fetched above is still used
            // below, for OUR OWN confirmation polling's expiry check,
            // which works identically regardless of who broadcast it.
            isCustodialExecution = Boolean(transaction && transaction.__custodialExecution);
            if(!isCustodialExecution){
                transaction.recentBlockhash = latestBlockhash.blockhash;
                if(!transaction.feePayer){
                    transaction.feePayer = new PublicKey(walletPublicKey);
                }
            }

            // Attach the blockhash/lastValidBlockHeight the confirmation
            // step will need, without moving the state - PREPARING is
            // already the current status, this just fills in the two
            // fields that weren't known at the moment of entering it.
            repository.transitionExecution(executionId, STATES.PREPARING, {
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            });

            preparedTransaction = transaction;
            preparedLastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

        }
        catch(err){
            machine.transition(STATES.FAILED, { errorMessage: err.message, completed: true });
            logger.logError(executionId, err.message);
            return { executionId, outcome: STATES.FAILED };
        }

        // ---- SIGNING: decrypt trading wallet, sign, never log the key.
        // Skipped for a custodial-execution provider (GMGN) - there is no
        // local transaction to sign; the state is still walked through
        // for consistent auditability, its action is just a no-op. ----
        try{
            machine.transition(STATES.SIGNING);
            if(!isCustodialExecution){
                signingService.sign(userId, preparedTransaction);
            }
        }
        catch(err){
            machine.transition(STATES.FAILED, { errorMessage: err.message, completed: true });
            logger.logError(executionId, err.message);
            return { executionId, outcome: STATES.FAILED };
        }

        // ---- SUBMITTING -> SUBMITTED: broadcast, then IMMEDIATELY persist
        // the tx_hash before any confirmation polling starts. This is the
        // crash-safe checkpoint - once SUBMITTED is written, a process
        // crash no longer loses the fact that a real transaction may be
        // on-chain (reconcilePendingExecutions() below recovers it).
        //
        // For a custodial-execution provider, preparedTransaction.submit()
        // IS the real, irreversible network call (GMGN signs and
        // broadcasts server-side in this one request) - it replaces
        // sendRawTransaction() at exactly the same point in the sequence,
        // so the crash-safety property holds identically either way. ----
        try{
            machine.transition(STATES.SUBMITTING);
            if(isCustodialExecution){
                const rpcStartedAt = Date.now();
                const result = await preparedTransaction.submit();
                signature = result.txHash;
                logger.logRpc(executionId, {
                    message: "GMGN swap submitted (server-side sign + broadcast)",
                    rpcEndpoint: "gmgn:/v1/trade/swap",
                    latencyMs: Date.now() - rpcStartedAt,
                    // Release Validation, checklist item 6/7: which SELL
                    // execution tier (TIER_1/TIER_2/FALLBACK) actually
                    // resolved this swap - undefined for BUY (never
                    // tiered), a real signal for how often the escalation
                    // path and the unconditional fallback are actually
                    // used in production. No new log call - the same RPC
                    // log this file already wrote before the Execution
                    // Safety Project, one field richer.
                    meta: { orderId: result.orderId, providerStatus: result.providerStatus, executionTier: preparedTransaction.executionTier ?? null }
                });
            }
            else{
                const connection = connectionProvider.getConnection();
                const rpcStartedAt = Date.now();
                signature = await connection.sendRawTransaction(preparedTransaction.serialize());
                logger.logRpc(executionId, {
                    message: "sendRawTransaction",
                    rpcEndpoint: connectionProvider.getEndpoint(),
                    latencyMs: Date.now() - rpcStartedAt
                });
            }
        }
        catch(err){
            machine.transition(STATES.FAILED, { errorMessage: err.message, completed: true });
            logger.logError(executionId, err.message);
            return { executionId, outcome: STATES.FAILED };
        }

        machine.transition(STATES.SUBMITTED, { txHash: signature });

        // ---- CONFIRMING: from here on, a thrown error must NOT become
        // FAILED - the transaction is already broadcast and may still
        // land. Leave the row at CONFIRMING and let
        // reconcilePendingExecutions() resolve it later rather than
        // guessing wrong in either direction. ----
        machine.transition(STATES.CONFIRMING);

        const confirmation = await confirmationService.confirm({ signature, lastValidBlockHeight: preparedLastValidBlockHeight });

        const meta = { confirmationResult: confirmation, completed: true };
        if(confirmation.outcome === STATES.FAILED){
            meta.errorMessage = JSON.stringify(confirmation.err);
        }
        machine.transition(STATES[confirmation.outcome], meta);

        // Arjuna V4 (Sprint 11), Part 1: only on a real, confirmed
        // SUCCESS - reads the confirmed transaction's own real pre/post
        // SOL+token balances for the trading wallet (never for
        // FAILED/TIMEOUT, there's no real settlement to read). Fails
        // soft - an error here never turns an otherwise-successful trade
        // into a failure; it only means actualAmounts comes back null,
        // and callers (tradeManager.js) fall back honestly rather than
        // fabricating a number.
        let actualAmounts = null;
        if(confirmation.outcome === STATES.SUCCESS){
            try{
                actualAmounts = await balanceReader.readActualSwapAmounts(signature, walletPublicKey, tokenAddress);
            }
            catch(err){
                logger.logError(executionId, `post-confirmation balance read failed (trade itself still succeeded): ${err.message}`);
            }
        }

        // txHash (Trust/UX sprint): `signature` was always real and in
        // scope here - it just never left this function, so
        // tradeManager.js's own `txHash` variable stayed permanently
        // null even after a real, confirmed trade. Every existing caller
        // already destructures only {executionId, outcome}, so this is
        // additive. actualAmounts (Arjuna V4, Part 1) is additive the
        // same way - null for every pre-Sprint-11 caller shape/test
        // double, real for a genuine confirmed SUCCESS.
        return { executionId, outcome: confirmation.outcome, txHash: signature, actualAmounts };

    }

    // Read-only truth recovery, NOT a retry - never rebuilds, re-signs,
    // or rebroadcasts a transaction. Finds every execution still sitting
    // in SUBMITTED/CONFIRMING with a real tx_hash (across every user,
    // hence the global, non-forUser repository call) and re-polls for
    // its actual outcome. Intended to run once at process boot (see
    // src/index.js) - not on a timer, not a cron.
    async function reconcilePendingExecutions(){

        const pending = repository.findPendingWithTxHash();
        const results = [];

        for(const row of pending){

            try{

                const machine = buildMachine(row.id, row.status);
                if(machine.getState() === STATES.SUBMITTED){
                    machine.transition(STATES.CONFIRMING);
                }

                const confirmation = await confirmationService.confirm({ signature: row.tx_hash, lastValidBlockHeight: row.last_valid_block_height });

                const meta = { confirmationResult: confirmation, completed: true };
                if(confirmation.outcome === STATES.FAILED){
                    meta.errorMessage = JSON.stringify(confirmation.err);
                }
                machine.transition(STATES[confirmation.outcome], meta);

                results.push({ executionId: row.id, outcome: confirmation.outcome });

            }
            catch(err){
                logger.logError(row.id, `reconciliation failed: ${err.message}`);
                results.push({ executionId: row.id, outcome: "RECONCILE_ERROR", error: err.message });
            }

        }

        return results;

    }

    // SPRINT 12 (Arjuna V5) - the counterpart recovery pass to
    // reconcilePendingExecutions() above, for the case that one can
    // never reach: a row stuck at IDLE/PREPARING/SIGNING/SUBMITTING with
    // NO tx_hash yet (a crash or a genuinely hung await before a real
    // signature was ever received). See
    // repositories/executionRepository.js's findStuckWithoutTxHash for
    // the full incident this closes - without this, such a row
    // permanently blocks that user's ONE-active-execution slot
    // (migration 045's own partial unique index), so no new BUY or SELL
    // could ever start again. There is no real signature to reconcile -
    // the only honest recovery is FAILED, releasing the lock.
    //
    // Called both at boot (src/index.js, alongside
    // reconcilePendingExecutions()) AND on a periodic timer while the
    // process keeps running - the CTO spec's own explicit requirement
    // ("Status SUBMITTING tidak boleh bertahan selamanya... Jika
    // timeout: FAIL -> release lock -> log") describes a live-operation
    // guarantee, not only a boot-time recovery.
    async function reconcileStuckExecutions(olderThanMs){

        const stuck = repository.findStuckWithoutTxHash(olderThanMs);
        const results = [];

        for(const row of stuck){

            try{

                const machine = buildMachine(row.id, row.status);
                // IDLE's only legal transition is to PREPARING - can't
                // jump straight to FAILED from there (executorStateMachine.js's
                // own LEGAL_TRANSITIONS table). Every other stuck state
                // (PREPARING/SIGNING/SUBMITTING) can go straight to FAILED.
                if(machine.getState() === STATES.IDLE){
                    machine.transition(STATES.PREPARING);
                }

                const ageMs = Date.now() - new Date(`${String(row.created_at).replace(" ", "T")}Z`).getTime();
                machine.transition(STATES.FAILED, {
                    errorMessage: `Execution stuck at ${row.status} for ${Math.round(ageMs / 1000)}s with no transaction signature - timed out, marked FAILED to release the execution lock`,
                    completed: true
                });

                logger.logError(row.id, `stuck execution force-FAILED after ${Math.round(ageMs / 1000)}s at status=${row.status} - lock released`);

                results.push({ executionId: row.id, outcome: STATES.FAILED, previousStatus: row.status });

            }
            catch(err){
                logger.logError(row.id, `stuck-execution reconciliation failed: ${err.message}`);
                results.push({ executionId: row.id, outcome: "RECONCILE_ERROR", error: err.message });
            }

        }

        return results;

    }

    return { execute, reconcilePendingExecutions, reconcileStuckExecutions };

}

module.exports = { createExecutionService };
