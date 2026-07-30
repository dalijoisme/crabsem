// scripts/validation/task2_stressTest.js - Sprint 1.5, Task 2 (stress
// test) + Task 7 (performance) + Task 5 (database validation), run
// together against the SAME isolated database so Task 5's checks
// reflect real data from a real 100-execution run, not a synthetic
// fixture. Uses simulatedConnectionProvider.js - real repository, real
// signing, real state machine, real logger, fake chain (see that
// file's header for why: deterministic, reproducible, and able to
// exercise failure modes that would be slow/unreliable to trigger
// on-demand against a real network).
//
// Fixed, reproducible 20-scenario weight pattern repeated 5x = 100
// sequential executions: 75 success / 5 on-chain error / 5 poll
// timeout / 5 blockhash-expired / 5 broadcast-rejected / 5 insufficient
// balance. Sequential, not concurrent, by design - see the dedicated
// concurrency sub-test below for duplicate-execution prevention, which
// IS deliberately concurrent.
//
// Usage: node src/scripts/validation/task2_stressTest.js [count]

const { setUpIsolatedDatabase, configureRpc, cleanUp, seedFounderAccount, buildExecutionServiceWithProvider } = require("./testHarness");

const harness = setUpIsolatedDatabase();
configureRpc();
process.env.EXECUTION_CONFIRMATION_TIMEOUT_MS = "300";  // fast timeouts for a 100-run stress test
process.env.EXECUTION_CONFIRMATION_POLL_INTERVAL_MS = "20";

const TOTAL = Number(process.argv[2]) || 100;

const SCENARIO_PATTERN = [
    ...Array(15).fill("success"),
    "onChainError",
    "pollTimeout",
    "blockhashExpired",
    "broadcastRejected",
    "lowBalance"
]; // length 20

function scenarioForIndex(i){
    return SCENARIO_PATTERN[i % SCENARIO_PATTERN.length];
}

const EXPECTED_OUTCOME = {
    success: "SUCCESS",
    onChainError: "FAILED",
    pollTimeout: "TIMEOUT",
    blockhashExpired: "TIMEOUT",
    broadcastRejected: "FAILED",
    lowBalance: "FAILED"
};

async function main(){

    console.log(`=== Sprint 1.5 / Task 2+5+7: Stress Test (${TOTAL} sequential executions) + DB + Performance ===`);
    console.log(`Isolated DB: ${harness.dbPath}`);

    // seedFounderAccount() runs the real migrations as its first step -
    // must happen before anything requires database/connection.js
    // (directly or transitively, e.g. via executionRepository below),
    // since that module opens/creates the sqlite file at REQUIRE time.
    const account = await seedFounderAccount("stress");
    console.log(`Seeded founder account: userId=${account.userId} tradingWallet=${account.tradingWalletPublicKey}`);

    const { createSimulatedConnectionProvider, behaviors } = require("./simulatedConnectionProvider");
    const provider = createSimulatedConnectionProvider(behaviors.success({ latencyMs: 4 }));
    const { executionService, executionRepository } = buildExecutionServiceWithProvider(provider);

    const results = [];
    const cpuStart = process.cpuUsage();
    let peakHeapUsedBytes = 0;
    let peakRssBytes = 0;
    const sampleMemory = () => {
        const mem = process.memoryUsage();
        peakHeapUsedBytes = Math.max(peakHeapUsedBytes, mem.heapUsed);
        peakRssBytes = Math.max(peakRssBytes, mem.rss);
    };

    const wallStart = Date.now();

    for(let i = 0; i < TOTAL; i++){

        const scenario = scenarioForIndex(i);
        provider.setBehavior(behaviors[scenario]({ latencyMs: 3 + (i % 4) }));
        provider.resetStats();

        const iterStart = Date.now();
        let outcome = null;
        let error = null;
        let executionId = null;

        try{
            const r = await executionService.execute({
                userId: account.userId,
                walletPublicKey: account.tradingWalletPublicKey,
                action: "STRESS_TEST"
            });
            outcome = r.outcome;
            executionId = r.executionId;
        }
        catch(err){
            error = err.message;
        }

        const iterElapsedMs = Date.now() - iterStart;
        sampleMemory();

        results.push({
            index: i, scenario, executionId, outcome, error,
            expectedOutcome: EXPECTED_OUTCOME[scenario],
            correct: outcome === EXPECTED_OUTCOME[scenario],
            elapsedMs: iterElapsedMs,
            rpcCallCount: provider.getCallCount(),
            rpcLatencies: provider.getLatencies()
        });

    }

    const wallElapsedMs = Date.now() - wallStart;
    const cpuDelta = process.cpuUsage(cpuStart); // {user, system} in microseconds

    // ---- Task 2: outcome rates + correctness ----
    const outcomeCounts = results.reduce((acc, r) => { acc[r.outcome ?? "THREW"] = (acc[r.outcome ?? "THREW"] || 0) + 1; return acc; }, {});
    const incorrect = results.filter(r => !r.correct);
    const successRatePct = (outcomeCounts.SUCCESS || 0) / TOTAL * 100;
    const failureRatePct = (outcomeCounts.FAILED || 0) / TOTAL * 100;
    const timeoutRatePct = (outcomeCounts.TIMEOUT || 0) / TOTAL * 100;

    const confirmedRuns = results.filter(r => ["SUCCESS", "FAILED", "TIMEOUT"].includes(r.outcome) && r.scenario !== "lowBalance");
    const avgExecuteLatencyMs = results.reduce((s, r) => s + r.elapsedMs, 0) / results.length;
    const allRpcLatencies = results.flatMap(r => r.rpcLatencies);
    const avgRpcLatencyMs = allRpcLatencies.length ? allRpcLatencies.reduce((a, b) => a + b, 0) / allRpcLatencies.length : null;

    // ---- Duplicate-execution prevention: a genuinely concurrent attempt ----
    provider.setBehavior(behaviors.success({ latencyMs: 30 })); // slow enough that both calls are in flight together
    let concurrentOk = false;
    let concurrentDetail = null;
    try{
        const [a, b] = await Promise.allSettled([
            executionService.execute({ userId: account.userId, walletPublicKey: account.tradingWalletPublicKey, action: "CONCURRENT_A" }),
            executionService.execute({ userId: account.userId, walletPublicKey: account.tradingWalletPublicKey, action: "CONCURRENT_B" })
        ]);
        const fulfilled = [a, b].filter(x => x.status === "fulfilled");
        const rejected = [a, b].filter(x => x.status === "rejected");
        concurrentOk = fulfilled.length === 1 && rejected.length === 1 && /already has an active execution/.test(rejected[0].reason.message);
        concurrentDetail = { fulfilledCount: fulfilled.length, rejectedCount: rejected.length, rejectionMessage: rejected[0]?.reason?.message ?? null };
    }
    catch(err){
        concurrentDetail = { unexpectedError: err.message };
    }

    // ---- Task 5: database validation, against the DB this run just produced ----
    const db = require("../../database/connection");

    const allExecutions = db.prepare("SELECT * FROM executions").all();
    const allLogs = db.prepare("SELECT * FROM execution_log").all();

    const duplicateIds = db.prepare("SELECT id, COUNT(*) c FROM executions GROUP BY id HAVING c > 1").all();
    const orphanLogs = db.prepare("SELECT execution_log.id FROM execution_log LEFT JOIN executions ON executions.id = execution_log.execution_id WHERE executions.id IS NULL").all();
    const validStatuses = ["IDLE", "PREPARING", "SIGNING", "SUBMITTING", "SUBMITTED", "CONFIRMING", "SUCCESS", "FAILED", "TIMEOUT"];
    const invalidStatusRows = db.prepare(`SELECT id, status FROM executions WHERE status NOT IN (${validStatuses.map(() => "?").join(",")})`).all(...validStatuses);
    const fkViolations = db.pragma("foreign_key_check");
    const timestampViolations = db.prepare("SELECT id, created_at, updated_at, completed_at FROM executions WHERE updated_at < created_at OR (completed_at IS NOT NULL AND completed_at < created_at)").all();
    const nonTerminalCount = db.prepare(`SELECT COUNT(*) c FROM executions WHERE status NOT IN ('SUCCESS','FAILED','TIMEOUT')`).get().c;

    // Deliberately violate the partial unique index to prove it's a
    // real database constraint, not just documentation.
    // executionRepository.insertExecution() bypasses the service
    // layer's own findActiveByUser() check entirely (this calls the
    // repository directly), so a first insert left deliberately
    // non-terminal, followed by a second insert for the same user,
    // exercises the DATABASE constraint itself, independent of any
    // service-layer logic.
    const deliberateFirstId = executionRepository.insertExecution(account.userId, { walletPublicKey: account.tradingWalletPublicKey, action: "UNIQUE_INDEX_PROBE_1", amountLamports: null, tokenAddress: null });
    executionRepository.transitionExecution(deliberateFirstId, "PREPARING", {}); // left non-terminal on purpose

    let partialUniqueIndexEnforced = false;
    let partialUniqueIndexError = null;
    try{
        executionRepository.insertExecution(account.userId, { walletPublicKey: account.tradingWalletPublicKey, action: "UNIQUE_INDEX_PROBE_2_SHOULD_BE_REJECTED", amountLamports: null, tokenAddress: null });
    }
    catch(err){
        partialUniqueIndexEnforced = /UNIQUE constraint failed/.test(err.message);
        partialUniqueIndexError = err.message;
    }
    // Clean up the deliberately-left-open probe row so it doesn't skew
    // nonTerminalRowsLeftAfterRun below.
    executionRepository.transitionExecution(deliberateFirstId, "FAILED", { errorMessage: "closed by the unique-index probe itself", completed: true });

    const dbValidation = {
        totalExecutionRows: allExecutions.length,
        totalLogRows: allLogs.length,
        duplicateIds,
        orphanLogs,
        invalidStatusRows,
        fkViolations,
        timestampViolations,
        nonTerminalRowsLeftAfterRun: nonTerminalCount, // should be 0 if partialUniqueIndexEnforced test above is the only leftover, else 1
        partialUniqueIndexEnforced,
        partialUniqueIndexError,
        pass: duplicateIds.length === 0 && orphanLogs.length === 0 && invalidStatusRows.length === 0 && fkViolations.length === 0 && timestampViolations.length === 0 && partialUniqueIndexEnforced
    };

    cleanUp(harness);

    const summary = {
        task: "2+5+7",
        totalExecutions: TOTAL,
        outcomeCounts,
        successRatePct, failureRatePct, timeoutRatePct,
        incorrectOutcomeCount: incorrect.length,
        incorrectOutcomes: incorrect.slice(0, 10),
        performance: {
            wallElapsedMs,
            avgExecuteLatencyMs,
            avgRpcLatencyMs,
            cpuUserMs: cpuDelta.user / 1000,
            cpuSystemMs: cpuDelta.system / 1000,
            peakHeapUsedMB: peakHeapUsedBytes / (1024 * 1024),
            peakRssMB: peakRssBytes / (1024 * 1024)
        },
        duplicatePrevention: { concurrentOk, concurrentDetail },
        databaseValidation: dbValidation,
        pass: incorrect.length === 0 && concurrentOk && dbValidation.pass
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
