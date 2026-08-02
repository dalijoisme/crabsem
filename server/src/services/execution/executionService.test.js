// services/execution/executionService.test.js - proves the full
// pipeline end to end with every collaborator faked (no real DB, no
// real RPC), a failure at each stage resolves to FAILED without ever
// broadcasting, the one-active-execution-per-user rule is enforced
// before anything is inserted, and reconcilePendingExecutions() can
// resolve a row left at SUBMITTED or CONFIRMING (simulating a restart
// after a crash) without ever re-signing or re-broadcasting anything.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Keypair } = require("@solana/web3.js");

const { createExecutionService } = require("./executionService");
const { STATES } = require("./executorStateMachine");

function fakeRepository(){
    const rows = new Map();
    const logs = [];
    let nextId = 1;
    return {
        rows, logs,
        insertExecution(userId, row){
            const id = nextId++;
            rows.set(id, {
                id, userId, status: STATES.IDLE, tx_hash: null, blockhash: null,
                last_valid_block_height: null, error_message: null,
                confirmation_result_json: null, ...row
            });
            return id;
        },
        findActiveByUser(){ return undefined; },
        transitionExecution(id, status, fields = {}){
            const row = rows.get(id);
            row.status = status;
            if(fields.blockhash != null) row.blockhash = fields.blockhash;
            if(fields.lastValidBlockHeight != null) row.last_valid_block_height = fields.lastValidBlockHeight;
            if(fields.txHash != null) row.tx_hash = fields.txHash;
            if(fields.errorMessage != null) row.error_message = fields.errorMessage;
            if(fields.confirmationResult != null) row.confirmation_result_json = JSON.stringify(fields.confirmationResult);
        },
        insertLog(executionId, entry){ logs.push({ executionId, ...entry }); },
        findPendingWithTxHash(){
            return [...rows.values()].filter(r => ["SUBMITTED", "CONFIRMING"].includes(r.status) && r.tx_hash);
        }
    };
}

function fakeConnectionProvider(){
    return {
        getConnection(){
            return {
                async getLatestBlockhash(){ return { blockhash: "bh-1", lastValidBlockHeight: 1000 }; },
                async sendRawTransaction(){ return "sig-abc"; }
            };
        },
        getEndpoint(){ return "http://fake-rpc.test"; }
    };
}

function fakeTransactionBuilder(){
    return {
        async build(){
            return { feePayer: null, recentBlockhash: null, serialize(){ return Buffer.from("fake-tx"); } };
        }
    };
}

// Custodial-execution builder (the gmgnSwapTransactionBuilder.js shape) -
// build() returns a marker + submit() closure instead of a signable
// Transaction. Tracks call counts so tests can prove the local signing
// path is never touched and submit() only ever fires during SUBMITTING.
function fakeCustodialTransactionBuilder({ submitTxHash = "gmgn-real-hash", submitError = null } = {}){
    let submitCalls = 0;
    return {
        get submitCalls(){ return submitCalls; },
        async build(){
            return {
                __custodialExecution: true,
                async submit(){
                    submitCalls++;
                    if(submitError) throw submitError;
                    return { txHash: submitTxHash, orderId: "order-1", providerStatus: "pending" };
                }
            };
        }
    };
}

function fakeSigningService(){
    let calls = 0;
    return {
        get calls(){ return calls; },
        sign(userId, transaction){ calls++; return transaction; }
    };
}

function fakeBalanceService(sufficient = true){
    return { async hasSufficientSolBalance(){ return sufficient; } };
}

function fakeConfirmationService(outcome){
    return {
        async confirm(){
            if(outcome === STATES.FAILED){
                return { outcome: STATES.FAILED, reason: "ON_CHAIN_ERROR", signature: "sig-abc", elapsedMs: 5, slot: 1, err: { InstructionError: [0, "Custom"] } };
            }
            if(outcome === STATES.TIMEOUT){
                return { outcome: STATES.TIMEOUT, reason: "POLL_WINDOW_ELAPSED", signature: "sig-abc", elapsedMs: 60000, slot: null, err: null };
            }
            return { outcome: STATES.SUCCESS, reason: null, signature: "sig-abc", elapsedMs: 5, slot: 42, err: null };
        }
    };
}

function fakeLogger(){
    const errors = [];
    return { logTransition(){}, logError(id, message){ errors.push({ id, message }); }, logRpc(){}, errors };
}

// Arjuna V4 (Sprint 11), Part 1.
function fakeBalanceReader(amounts = { solDeltaLamports: -34814000, tokenDeltaUi: 1000000, blockTime: 1785000000, slot: 42 }){
    return { calls: 0, async readActualSwapAmounts(){ this.calls++; return amounts; } };
}

function throwingBalanceReader(message = "RPC hiccup"){
    return { async readActualSwapAmounts(){ throw new Error(message); } };
}

function buildService(overrides = {}){
    const repository = overrides.repository ?? fakeRepository();
    return {
        repository,
        service: createExecutionService({
            repository,
            connectionProvider: overrides.connectionProvider ?? fakeConnectionProvider(),
            signingService: overrides.signingService ?? fakeSigningService(),
            balanceService: overrides.balanceService ?? fakeBalanceService(),
            confirmationService: overrides.confirmationService ?? fakeConfirmationService(STATES.SUCCESS),
            transactionBuilder: overrides.transactionBuilder ?? fakeTransactionBuilder(),
            logger: overrides.logger ?? fakeLogger(),
            balanceReader: overrides.balanceReader
        })
    };
}

const walletPublicKey = Keypair.generate().publicKey.toBase58();

test("full pipeline resolves SUCCESS and persists a real tx_hash", async () => {
    const { service, repository } = buildService();
    const result = await service.execute({ userId: 1, walletPublicKey, action: "TEST_TRANSFER" });

    assert.equal(result.outcome, STATES.SUCCESS);
    // Trust/UX sprint: the real signature must also come back on the
    // returned result, not just persisted in the repository row - this
    // is what tradeManager.js's finalizeClose() now reads to stop
    // writing a permanently-null tx_hash on real closes.
    assert.equal(result.txHash, "sig-abc");
    const row = repository.rows.get(result.executionId);
    assert.equal(row.status, STATES.SUCCESS);
    assert.equal(row.tx_hash, "sig-abc");
    assert.equal(row.blockhash, "bh-1");
});

// =====================================
// Arjuna V4 (Sprint 11), Part 1 - real on-chain balance-delta capture.
// =====================================

test("a real SUCCESS reads actual on-chain swap amounts via balanceReader, and returns them", async () => {
    const reader = fakeBalanceReader();
    const { service } = buildService({ balanceReader: reader });
    const result = await service.execute({ userId: 1, walletPublicKey, action: "BUY", amountLamports: 1000, tokenAddress: "TokenMintABC" });

    assert.equal(result.outcome, STATES.SUCCESS);
    assert.equal(reader.calls, 1);
    assert.deepEqual(result.actualAmounts, { solDeltaLamports: -34814000, tokenDeltaUi: 1000000, blockTime: 1785000000, slot: 42 });
});

test("a FAILED/TIMEOUT outcome never attempts a balance-delta read - there is no real settlement to read", async () => {
    const reader = fakeBalanceReader();
    const { service } = buildService({ balanceReader: reader, confirmationService: fakeConfirmationService(STATES.FAILED) });
    const result = await service.execute({ userId: 1, walletPublicKey, action: "TEST_TRANSFER" });

    assert.equal(result.outcome, STATES.FAILED);
    assert.equal(reader.calls, 0);
});

test("a balance-delta read failure never turns an otherwise-successful trade into a failure - fails soft, actualAmounts comes back null", async () => {
    const logger = fakeLogger();
    const { service } = buildService({ balanceReader: throwingBalanceReader("RPC index lagging"), logger });
    const result = await service.execute({ userId: 1, walletPublicKey, action: "BUY", amountLamports: 1000, tokenAddress: "TokenMintABC" });

    assert.equal(result.outcome, STATES.SUCCESS, "the real trade already succeeded - a post-confirmation read error must never retroactively fail it");
    assert.equal(result.actualAmounts, null);
    assert.ok(logger.errors.some(e => e.message.includes("RPC index lagging")));
});

test("no balanceReader supplied (every pre-Sprint-11 caller/test-double) defaults to a safe no-op - actualAmounts is null, never throws", async () => {
    const { service } = buildService(); // no balanceReader override at all
    const result = await service.execute({ userId: 1, walletPublicKey, action: "TEST_TRANSFER" });

    assert.equal(result.outcome, STATES.SUCCESS);
    assert.equal(result.actualAmounts, null);
});

test("insufficient balance fails during PREPARING, before signing is ever attempted", async () => {
    const signingService = fakeSigningService();
    const { service, repository } = buildService({ balanceService: fakeBalanceService(false), signingService });

    const result = await service.execute({ userId: 1, walletPublicKey, action: "TEST_TRANSFER" });

    assert.equal(result.outcome, STATES.FAILED);
    assert.equal(signingService.calls, 0);
    const row = repository.rows.get(result.executionId);
    assert.equal(row.status, STATES.FAILED);
    assert.ok(row.error_message.includes("insufficient"));
    assert.equal(row.tx_hash, null); // never reached broadcast
});

// Regression test for a real, proven production bug: tradeManager.js's
// finalizeClose() passes the TOKEN's own raw base-unit balance as
// amountLamports for a SELL (correct - gmgnSwapTransactionBuilder.js
// needs that exact figure to know how much of the token to swap), but
// the PREPARING balance check used to fold amountLamports into the
// required-SOL floor unconditionally, regardless of action. A real
// wallet holding thousands of a low-decimal memecoin (raw balance in
// the billions) but only a fraction of a SOL would always fail this
// check, even though a SELL spends the token, never SOL, for the
// swapped amount - only the network-fee buffer is real SOL cost.
// Verified against this account's own real, failed SELL executions
// (MOON: amountLamports 7573760666 against a real wallet balance of
// 103601988 lamports) before this fix landed.
test("a SELL's large token-quantity amountLamports never inflates the required-SOL floor - only BUY's does", async () => {

    const seenRequiredLamports = [];
    const balanceService = {
        async hasSufficientSolBalance(walletPublicKey, requiredLamports){
            seenRequiredLamports.push(requiredLamports);
            // Simulates this account's real shape: a small real SOL
            // balance that can never cover a token's raw base-unit count,
            // but comfortably covers the real network-fee floor.
            return requiredLamports <= 103601988;
        }
    };

    // SELL: a huge raw token balance (bigger than the real SOL balance
    // by orders of magnitude) must NOT be added to the required-SOL
    // floor - only MIN_FEE_BUFFER_LAMPORTS (5000) should be required.
    const sellResult = await buildService({ balanceService }).service.execute({
        userId: 1, walletPublicKey, action: "SELL", amountLamports: 7573760666, tokenAddress: "SomeTokenMint111"
    });
    assert.equal(sellResult.outcome, STATES.SUCCESS, "a SELL must never be rejected for 'insufficient SOL' based on the token quantity being sold");
    assert.equal(seenRequiredLamports.at(-1), 5000, "SELL's required-SOL floor must be exactly the fee buffer, never amountLamports + buffer");

    // BUY: amountLamports genuinely IS SOL to spend - the required-SOL
    // floor must still include it, unchanged from before this fix.
    const buyResult = await buildService({ balanceService }).service.execute({
        userId: 1, walletPublicKey, action: "BUY", amountLamports: 200000000, tokenAddress: "SomeTokenMint111"
    });
    assert.equal(buyResult.outcome, STATES.FAILED, "BUY must still fail when it genuinely can't afford the real SOL amount requested");
    assert.equal(seenRequiredLamports.at(-1), 200005000, "BUY's required-SOL floor must still be amountLamports + buffer, unchanged");

});

test("a genuine on-chain error resolves to FAILED with the confirmation result recorded", async () => {
    const { service, repository } = buildService({ confirmationService: fakeConfirmationService(STATES.FAILED) });
    const result = await service.execute({ userId: 1, walletPublicKey, action: "TEST_TRANSFER" });

    assert.equal(result.outcome, STATES.FAILED);
    const row = repository.rows.get(result.executionId);
    assert.equal(row.status, STATES.FAILED);
    assert.equal(row.tx_hash, "sig-abc"); // broadcast DID happen - this is a real on-chain rejection, not a pre-broadcast failure
    assert.ok(row.confirmation_result_json.includes("ON_CHAIN_ERROR"));
});

test("a poll timeout resolves to TIMEOUT, not FAILED - the outcome is genuinely unknown", async () => {
    const { service, repository } = buildService({ confirmationService: fakeConfirmationService(STATES.TIMEOUT) });
    const result = await service.execute({ userId: 1, walletPublicKey, action: "TEST_TRANSFER" });

    assert.equal(result.outcome, STATES.TIMEOUT);
    const row = repository.rows.get(result.executionId);
    assert.equal(row.status, STATES.TIMEOUT);
    assert.equal(row.error_message, null); // TIMEOUT is not an error verdict
});

test("rejects a second execution while one is already active, without inserting a new row", async () => {
    const repository = fakeRepository();
    repository.findActiveByUser = () => ({ id: 7, status: STATES.CONFIRMING });
    const { service } = buildService({ repository });

    await assert.rejects(
        () => service.execute({ userId: 1, walletPublicKey, action: "TEST_TRANSFER" }),
        /already has an active execution/
    );
    assert.equal(repository.rows.size, 0);
});

test("reconcilePendingExecutions resolves a row stuck at SUBMITTED (simulated crash) without re-signing or re-broadcasting", async () => {
    const repository = fakeRepository();
    const signingService = fakeSigningService();
    const stuckId = repository.insertExecution(1, { walletPublicKey, action: "TEST_TRANSFER", amountLamports: null, tokenAddress: null });
    repository.transitionExecution(stuckId, STATES.SUBMITTED, { txHash: "sig-stuck" });

    const { service } = buildService({ repository, signingService, confirmationService: fakeConfirmationService(STATES.SUCCESS) });

    const results = await service.reconcilePendingExecutions();

    assert.equal(signingService.calls, 0); // reconciliation never signs anything
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, STATES.SUCCESS);
    assert.equal(repository.rows.get(stuckId).status, STATES.SUCCESS);
});

test("reconcilePendingExecutions resolves a row already at CONFIRMING", async () => {
    const repository = fakeRepository();
    const id = repository.insertExecution(1, { walletPublicKey, action: "TEST_TRANSFER", amountLamports: null, tokenAddress: null });
    repository.transitionExecution(id, STATES.SUBMITTED, { txHash: "sig-confirming" });
    repository.transitionExecution(id, STATES.CONFIRMING, {});

    const { service } = buildService({ repository, confirmationService: fakeConfirmationService(STATES.TIMEOUT) });
    const results = await service.reconcilePendingExecutions();

    assert.equal(results[0].outcome, STATES.TIMEOUT);
    assert.equal(repository.rows.get(id).status, STATES.TIMEOUT);
});

test("reconcilePendingExecutions ignores rows with no tx_hash and terminal rows", async () => {
    const repository = fakeRepository();
    const idleId = repository.insertExecution(1, { walletPublicKey, action: "TEST_TRANSFER", amountLamports: null, tokenAddress: null });
    const doneId = repository.insertExecution(1, { walletPublicKey, action: "TEST_TRANSFER", amountLamports: null, tokenAddress: null });
    repository.transitionExecution(doneId, STATES.SUCCESS, { txHash: "sig-done", completed: true });

    const { service } = buildService({ repository });
    const results = await service.reconcilePendingExecutions();

    assert.equal(results.length, 0);
    assert.equal(repository.rows.get(idleId).status, STATES.IDLE);
});

// ---- Custodial execution path (Sprint 2, Founder Decision - Path A) ----

test("custodial execution: local signing is never called, submit() provides the real tx_hash", async () => {
    const signingService = fakeSigningService();
    const transactionBuilder = fakeCustodialTransactionBuilder({ submitTxHash: "gmgn-signature-abc" });
    const { service, repository } = buildService({ transactionBuilder, signingService });

    const result = await service.execute({ userId: 1, walletPublicKey, action: "BUY" });

    assert.equal(result.outcome, STATES.SUCCESS);
    assert.equal(signingService.calls, 0); // GMGN signs server-side - local signingService must never be called
    assert.equal(transactionBuilder.submitCalls, 1);
    const row = repository.rows.get(result.executionId);
    assert.equal(row.tx_hash, "gmgn-signature-abc");
});

test("custodial execution: submit() failing resolves to FAILED the same way a local broadcast failure would", async () => {
    const transactionBuilder = fakeCustodialTransactionBuilder({ submitError: new Error("GMGN rejected the swap: insufficient liquidity") });
    const { service, repository } = buildService({ transactionBuilder });

    const result = await service.execute({ userId: 1, walletPublicKey, action: "BUY" });

    assert.equal(result.outcome, STATES.FAILED);
    assert.equal(transactionBuilder.submitCalls, 1);
    const row = repository.rows.get(result.executionId);
    assert.ok(row.error_message.includes("insufficient liquidity"));
    assert.equal(row.tx_hash, null); // submit() never returned a hash, so none was ever recorded
});

test("custodial execution: build() itself throwing (e.g. Execution Guard rejection) never calls submit()", async () => {
    const transactionBuilder = {
        submitCalls: 0,
        async build(){ throw new Error("gmgnSwapTransactionBuilder: price impact too high"); }
    };
    const { service, repository } = buildService({ transactionBuilder });

    const result = await service.execute({ userId: 1, walletPublicKey, action: "BUY" });

    assert.equal(result.outcome, STATES.FAILED);
    assert.equal(transactionBuilder.submitCalls, 0);
    const row = repository.rows.get(result.executionId);
    assert.ok(row.error_message.includes("price impact too high"));
});

test("custodial execution: a locally-signed builder (selfTransferTransactionBuilder shape) is completely unaffected", async () => {
    // Regression guard: the default fakeTransactionBuilder() (no
    // __custodialExecution marker) must still take the original local
    // sign + sendRawTransaction path, byte-identical to before this
    // adaptation existed.
    const signingService = fakeSigningService();
    const { service } = buildService({ signingService });

    const result = await service.execute({ userId: 1, walletPublicKey, action: "TEST_TRANSFER" });

    assert.equal(result.outcome, STATES.SUCCESS);
    assert.equal(signingService.calls, 1);
});
