// scripts/validation/task3_crashRecovery.js - Sprint 1.5, Task 3: every
// named crash scenario, verified against a real isolated database and
// the real reconcilePendingExecutions(). A "crash" is simulated the
// only honest way one can be simulated without actually killing the
// process: by driving executionRepository.transitionExecution()
// directly (bypassing executionService.execute() and its state
// machine entirely) to leave a row exactly where a real crash would
// have left it, then starting a FRESH executionService instance (a new
// require of the state machine/logger, matching what a real process
// restart looks like) and running reconciliation against it.
//
// Usage: node src/scripts/validation/task3_crashRecovery.js

const { setUpIsolatedDatabase, configureRpc, cleanUp, seedFounderAccount, buildExecutionServiceWithProvider } = require("./testHarness");

const harness = setUpIsolatedDatabase();
configureRpc();
process.env.EXECUTION_CONFIRMATION_TIMEOUT_MS = "300";
process.env.EXECUTION_CONFIRMATION_POLL_INTERVAL_MS = "20";

function wrapSigningServiceWithSpy(realSigningService){
    let signCallCount = 0;
    return {
        signCallCount: () => signCallCount,
        sign(userId, transaction){
            signCallCount++;
            return realSigningService.sign(userId, transaction);
        }
    };
}

async function main(){

    console.log("=== Sprint 1.5 / Task 3: Crash Recovery ===");

    // One real seeded account per scenario - executions.user_id is a
    // real foreign key into users(id) (foreign_keys=ON), and the
    // partial unique index allows at most one NON-TERMINAL row per
    // user, so simulating "multiple pending executions across
    // different users" for real requires actually distinct, real users,
    // not fabricated ids.
    const accounts = [];
    for(let i = 0; i < 6; i++) accounts.push(await seedFounderAccount(`crash${i}`));
    console.log(`Seeded ${accounts.length} real founder accounts: userIds ${accounts.map(a => a.userId).join(", ")}`);

    const executionRepository = require("../../repositories/executionRepository");
    const tradingWalletRepository = require("../../repositories/tradingWalletRepository");
    const walletService = require("../../services/walletService");
    const { createTransactionSigningService } = require("../../services/execution/transactionSigningService");

    const realSigningService = createTransactionSigningService({ walletService, tradingWalletRepository });
    const signingSpy = wrapSigningServiceWithSpy(realSigningService);

    const { createSimulatedConnectionProvider, behaviors } = require("./simulatedConnectionProvider");

    const scenarios = [];

    // ---- Scenario A: crash after SIGNING (signed, never broadcast - no tx_hash exists at all) ----
    {
        const a = accounts[0];
        const id = executionRepository.insertExecution(a.userId, { walletPublicKey: a.tradingWalletPublicKey, action: "CRASH_AFTER_SIGNING", amountLamports: null, tokenAddress: null });
        executionRepository.transitionExecution(id, "PREPARING", { blockhash: "n/a", lastValidBlockHeight: 1 });
        executionRepository.transitionExecution(id, "SIGNING", {});
        // process "crashes" here - sendRawTransaction was never called, no tx_hash was ever generated
        scenarios.push({ name: "crash_after_signing", id, expectReconciled: false, expectFinalStatus: "SIGNING" });
    }

    // ---- Scenario B: crash after SUBMITTED (tx_hash recorded, confirmation never started) ----
    {
        const a = accounts[1];
        const id = executionRepository.insertExecution(a.userId, { walletPublicKey: a.tradingWalletPublicKey, action: "CRASH_AFTER_SUBMITTED", amountLamports: null, tokenAddress: null });
        executionRepository.transitionExecution(id, "PREPARING", { blockhash: "n/a", lastValidBlockHeight: 1 });
        executionRepository.transitionExecution(id, "SIGNING", {});
        executionRepository.transitionExecution(id, "SUBMITTING", {});
        executionRepository.transitionExecution(id, "SUBMITTED", { txHash: "CrashSig_SUBMITTED_" + id });
        scenarios.push({ name: "crash_after_submitted", id, expectReconciled: true, expectFinalStatus: "SUCCESS" });
    }

    // ---- Scenario C: crash before confirmation resolves (already at CONFIRMING) ----
    {
        const a = accounts[2];
        const id = executionRepository.insertExecution(a.userId, { walletPublicKey: a.tradingWalletPublicKey, action: "CRASH_BEFORE_CONFIRMATION", amountLamports: null, tokenAddress: null });
        executionRepository.transitionExecution(id, "PREPARING", { blockhash: "n/a", lastValidBlockHeight: 1 });
        executionRepository.transitionExecution(id, "SIGNING", {});
        executionRepository.transitionExecution(id, "SUBMITTING", {});
        executionRepository.transitionExecution(id, "SUBMITTED", { txHash: "CrashSig_CONFIRMING_" + id });
        executionRepository.transitionExecution(id, "CONFIRMING", {});
        scenarios.push({ name: "crash_before_confirmation", id, expectReconciled: true, expectFinalStatus: "FAILED" });
    }

    // ---- Scenario D: restart with MULTIPLE pending executions at once (different real users) ----
    for(let i = 0; i < 3; i++){
        const a = accounts[3 + i];
        const id = executionRepository.insertExecution(a.userId, { walletPublicKey: a.tradingWalletPublicKey, action: `CRASH_MULTI_${i}`, amountLamports: null, tokenAddress: null });
        executionRepository.transitionExecution(id, "PREPARING", { blockhash: "n/a", lastValidBlockHeight: 1 });
        executionRepository.transitionExecution(id, "SIGNING", {});
        executionRepository.transitionExecution(id, "SUBMITTING", {});
        executionRepository.transitionExecution(id, "SUBMITTED", { txHash: `CrashSig_MULTI_${i}_${id}` });
        scenarios.push({ name: `crash_multi_restart_${i}`, id, expectReconciled: true, expectFinalStatus: i === 2 ? "TIMEOUT" : "SUCCESS" });
    }

    console.log(`Seeded ${scenarios.length} crash scenarios across ${new Set(scenarios.map(s => s.id)).size} execution rows.`);

    // ---- "Restart": a fresh executionService instance, fresh
    // simulated provider, exactly like a real process boot would build
    // one. Behavior: SUBMITTED-scenario B and multi-0 confirm as
    // SUCCESS, CONFIRMING-scenario C confirms as an on-chain FAILED,
    // multi-2 times out - so the report covers all three real
    // reconciliation outcomes, not just the happy path.
    const provider = createSimulatedConnectionProvider(behaviors.success({ latencyMs: 5 }));
    const { executionService } = buildExecutionServiceWithProvider(provider, { signingService: signingSpy });

    const preRestartSignCalls = signingSpy.signCallCount();
    const preRestartBroadcastCalls = provider.getCallCount();

    // Give each tx_hash its own scripted outcome by pattern-matching
    // the signature string set above - a real reconcile call polls
    // getSignatureStatus once per pending row; this behavior answers
    // deterministically per-signature rather than per-call-index.
    provider.setBehavior({
        async latestBlockhash(){ return { blockhash: require("@solana/web3.js").Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000_000 }; },
        async sendRawTransaction(){ throw new Error("reconciliation must never call sendRawTransaction"); },
        async signatureStatus(signature){
            if(signature.includes("MULTI_2")) return { value: null }; // never confirms -> TIMEOUT
            if(signature.includes("CONFIRMING")) return { value: { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed", slot: 1 } };
            return { value: { err: null, confirmationStatus: "confirmed", slot: 1 } };
        },
        async blockHeight(){ return 1; },
        async balance(){ return 1_000_000_000; },
        async tokenAccounts(){ return { value: [] }; }
    });

    console.log("Running reconcilePendingExecutions() (simulating a fresh process restart)...");
    const reconcileResults = await executionService.reconcilePendingExecutions();

    const postRestartSignCalls = signingSpy.signCallCount();
    const postRestartBroadcastCalls = provider.getCallCount(); // includes signatureStatus/blockHeight calls too - see the check below for the specific broadcast guarantee

    // ---- Verify every scenario resolved exactly as expected ----
    // findById() is user-scoped by design (security) - this crash-
    // recovery check deliberately spans several different synthetic
    // user ids (see scenarios B/C/D above), so rows are read directly
    // here, the same way a real ops/reconciliation report legitimately
    // would (reconcilePendingExecutions() itself already reads across
    // all users via findPendingWithTxHash(), not per-user).
    const db = require("../../database/connection");
    const finalRows = scenarios.map(s => ({ ...s, actualStatus: db.prepare("SELECT status, tx_hash FROM executions WHERE id = ?").get(s.id).status }));
    const mismatches = finalRows.filter(r => r.actualStatus !== r.expectFinalStatus);

    // Scenario A (crash after SIGNING, no tx_hash) is EXPECTED to be
    // untouched by reconciliation - it is documented here as a real,
    // known gap (see the report), not silently treated as a defect in
    // this script.
    const scenarioAFinal = db.prepare("SELECT status FROM executions WHERE id = ?").get(scenarios[0].id).status;
    const scenarioACorrectlyUntouched = scenarioAFinal === "SIGNING";

    const neverSignedAgain = postRestartSignCalls === preRestartSignCalls; // must be 0 delta
    let neverBroadcastAgain = true;
    try{
        // sendRawTransaction throws if ever called during reconciliation -
        // if reconcileResults contains no RECONCILE_ERROR entries whose
        // message mentions "sendRawTransaction", it was never invoked.
        neverBroadcastAgain = !reconcileResults.some(r => (r.error || "").includes("sendRawTransaction"));
    }
    catch(e){ neverBroadcastAgain = false; }

    cleanUp(harness);

    const summary = {
        task: 3,
        scenarioCount: scenarios.length,
        scenarios: finalRows,
        mismatches: mismatches.filter(r => r.name !== "crash_after_signing"), // scenario A is handled separately below
        scenarioA_crashAfterSigning: {
            description: "Crash between SIGNING succeeding and SUBMITTING ever being attempted - nothing was broadcast, so there is genuinely nothing on-chain to reconcile.",
            row_left_at: scenarioAFinal,
            correctlyLeftUntouchedByReconciliation: scenarioACorrectlyUntouched,
            knownGap: "This row stays non-terminal forever unless an operator manually resolves it - reconcilePendingExecutions() only looks at rows with a real tx_hash, and this one never got one. See the report for the recommendation."
        },
        reconcileResults,
        neverSignedAgain,
        neverBroadcastAgain,
        preRestartSignCalls, postRestartSignCalls,
        pass: mismatches.filter(r => r.name !== "crash_after_signing").length === 0 && scenarioACorrectlyUntouched && neverSignedAgain && neverBroadcastAgain
    };

    console.log("===RESULT_JSON===");
    console.log(JSON.stringify(summary, null, 2));

    process.exitCode = summary.pass ? 0 : 1;

}

main().catch((err) => {
    console.error("FATAL:", err);
    cleanUp(harness);
    process.exitCode = 1;
});
