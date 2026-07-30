// scripts/validation/task6_balanceValidation.js - Sprint 1.5, Task 6:
// balance validation edge cases, checked at TWO levels for each case -
// (1) balanceValidationService.js directly, and (2) the full
// executionService.execute() pipeline, to prove a bad balance
// situation doesn't just return the "right number" but actually stops
// the pipeline BEFORE signing/broadcasting anything ("fail closed").
//
// Usage: node src/scripts/validation/task6_balanceValidation.js

const { setUpIsolatedDatabase, configureRpc, cleanUp, seedFounderAccount, buildExecutionServiceWithProvider } = require("./testHarness");

const harness = setUpIsolatedDatabase();
configureRpc();
process.env.EXECUTION_CONFIRMATION_TIMEOUT_MS = "300";
process.env.EXECUTION_CONFIRMATION_POLL_INTERVAL_MS = "20";

async function main(){

    console.log("=== Sprint 1.5 / Task 6: Balance Validation ===");

    const accounts = [];
    for(let i = 0; i < 6; i++) accounts.push(await seedFounderAccount(`bal${i}`));
    console.log(`Seeded ${accounts.length} real founder accounts.`);

    const { createSimulatedConnectionProvider, behaviors } = require("./simulatedConnectionProvider");
    const { createBalanceValidationService } = require("../../services/execution/balanceValidationService");

    const cases = [];

    async function runCase(name, { userIndex, behavior, walletOverride, expectPipelineOutcome, expectPipelineFailsBeforeSigning }){

        const account = accounts[userIndex];
        const walletPublicKey = walletOverride ?? account.tradingWalletPublicKey;

        const provider = createSimulatedConnectionProvider(behavior);
        const directBalanceService = createBalanceValidationService(provider);

        // Level 1: balanceValidationService directly
        let directResult = null;
        let directError = null;
        try{
            directResult = await directBalanceService.getNativeSolBalanceLamports(walletPublicKey);
        }
        catch(err){
            directError = err.message;
        }

        // Level 2: full pipeline - proves the bad balance actually
        // stops PREPARING, before any signing/broadcast is attempted.
        let signCallCount = 0;
        const executionRepository = require("../../repositories/executionRepository");
        const tradingWalletRepository = require("../../repositories/tradingWalletRepository");
        const walletService = require("../../services/walletService");
        const { createTransactionSigningService } = require("../../services/execution/transactionSigningService");
        const realSigning = createTransactionSigningService({ walletService, tradingWalletRepository });
        const signingSpy = { sign(userId, tx){ signCallCount++; return realSigning.sign(userId, tx); } };

        const { executionService } = buildExecutionServiceWithProvider(provider, { signingService: signingSpy });

        let pipelineOutcome = null;
        let pipelineError = null;
        try{
            const r = await executionService.execute({ userId: account.userId, walletPublicKey, action: `BALANCE_CASE_${name}` });
            pipelineOutcome = r.outcome;
        }
        catch(err){
            pipelineError = err.message;
        }

        const pipelineFailedBeforeSigning = pipelineOutcome === "FAILED" && signCallCount === 0;

        const caseResult = {
            name,
            walletPublicKey,
            directBalanceLamports: directResult,
            directError,
            pipelineOutcome,
            pipelineError,
            signCallCount,
            expectPipelineOutcome,
            pipelineOutcomeCorrect: pipelineOutcome === expectPipelineOutcome || pipelineError !== null && expectPipelineOutcome === "THREW",
            failedClosed: expectPipelineFailsBeforeSigning ? pipelineFailedBeforeSigning : true
        };

        cases.push(caseResult);
        console.log(`  [${name}] direct=${directResult ?? directError} pipeline=${pipelineOutcome ?? `THREW:${pipelineError}`} signCalls=${signCallCount}`);

    }

    console.log("Running balance edge cases...");

    await runCase("normal_sol_balance", {
        userIndex: 0,
        behavior: behaviors.success({ balanceLamports: 1_000_000_000 }),
        expectPipelineOutcome: "SUCCESS",
        expectPipelineFailsBeforeSigning: false
    });

    await runCase("empty_wallet", {
        userIndex: 1,
        behavior: behaviors.emptyWallet(),
        expectPipelineOutcome: "FAILED",
        expectPipelineFailsBeforeSigning: true
    });

    await runCase("low_balance_below_fee_buffer", {
        userIndex: 2,
        behavior: behaviors.lowBalance(), // 1000 lamports, below MIN_FEE_BUFFER_LAMPORTS (5000)
        expectPipelineOutcome: "FAILED",
        expectPipelineFailsBeforeSigning: true
    });

    await runCase("invalid_wallet_address", {
        userIndex: 4,
        behavior: behaviors.success(),
        walletOverride: "not-a-real-solana-address!!",
        // The pipeline catches this cleanly during PREPARING (a
        // malformed address throws inside balanceValidationService,
        // caught by executionService's own try/catch) - it fails
        // closed as a normal FAILED outcome, never an uncaught
        // exception out of execute() itself. Confirmed by running this
        // case first and reading the real result before fixing this
        // expectation - see the report's Task 6 findings.
        expectPipelineOutcome: "FAILED",
        expectPipelineFailsBeforeSigning: true
    });

    await runCase("rpc_unavailable", {
        userIndex: 5,
        behavior: behaviors.rpcUnavailable(),
        expectPipelineOutcome: "FAILED",
        expectPipelineFailsBeforeSigning: true
    });

    // insufficient_for_requested_amount needs a real amountLamports on
    // the execute() call, not just a low balance - re-run case 4's
    // account with an explicit amount to actually exercise that branch
    // of the required-lamports math (amountLamports + MIN_FEE_BUFFER_LAMPORTS).
    {
        const account = accounts[3];
        const provider = createSimulatedConnectionProvider(behaviors.success({ balanceLamports: 6000 }));
        const { executionService } = buildExecutionServiceWithProvider(provider);
        const r = await executionService.execute({ userId: account.userId, walletPublicKey: account.tradingWalletPublicKey, action: "BALANCE_CASE_amount_plus_fee_exceeds_balance", amountLamports: 5000 });
        cases.push({
            name: "amount_plus_fee_exceeds_balance",
            note: "balance=6000, requested amount=5000, fee buffer=5000 -> needs 10000, has 6000",
            pipelineOutcome: r.outcome,
            expectPipelineOutcome: "FAILED",
            pipelineOutcomeCorrect: r.outcome === "FAILED",
            failedClosed: r.outcome === "FAILED"
        });
    }

    // SPL token balance - a missing associated token account must read
    // as a real, honest zero, never an error and never "assumed sufficient".
    {
        const account = accounts[0];
        const provider = createSimulatedConnectionProvider(behaviors.success({ tokenAccounts: [] }));
        const balanceService = createBalanceValidationService(provider);
        const fakeMint = require("@solana/web3.js").Keypair.generate().publicKey.toBase58();
        const splResult = await balanceService.getSplTokenBalance(account.tradingWalletPublicKey, fakeMint);
        cases.push({
            name: "spl_balance_no_token_account",
            splResult,
            correct: splResult.amountRaw === "0" && splResult.uiAmount === 0,
            failedClosed: true // "no data" reads as zero, never fabricated as sufficient
        });
    }

    cleanUp(harness);

    const allCorrect = cases.every(c => (c.pipelineOutcomeCorrect ?? c.correct ?? true) && c.failedClosed);

    const summary = {
        task: 6,
        caseCount: cases.length,
        cases,
        pass: allCorrect
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
