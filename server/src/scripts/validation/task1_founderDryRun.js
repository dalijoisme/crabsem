// scripts/validation/task1_founderDryRun.js - Sprint 1.5, Task 1: a
// complete Founder Dry Run against REAL Solana devnet, through the
// exact SAME production wiring (services/execution/index.js) a real
// route would use - not a re-assembled test double. Uses ONLY the
// existing harmless selfTransferTransactionBuilder.js (a 0-lamport
// self-transfer) - no GMGN, no Jupiter, no BUY/SELL/swap.
//
// Isolated temp database (see testHarness.js) - never
// server/data/crabsem.sqlite. Funds the freshly-generated Trading
// Wallet via a real devnet airdrop so it can pay a real network fee.
//
// Usage: node src/scripts/validation/task1_founderDryRun.js

const { setUpIsolatedDatabase, configureRpc, cleanUp, seedFounderAccount } = require("./testHarness");

const harness = setUpIsolatedDatabase();
configureRpc("https://api.devnet.solana.com");

async function main(){

    console.log("=== Sprint 1.5 / Task 1: Founder Dry Run (real Solana devnet) ===");
    console.log(`Isolated DB: ${harness.dbPath}`);

    const account = await seedFounderAccount("dryrun");
    console.log(`Seeded founder account: userId=${account.userId} tradingWallet=${account.tradingWalletPublicKey}`);

    const { PublicKey } = require("@solana/web3.js");
    const { executionService, executionRepository, connectionProvider } = require("../../services/execution");

    const connection = connectionProvider.getConnection();
    const walletPubkey = new PublicKey(account.tradingWalletPublicKey);

    console.log("Requesting a devnet airdrop (0.05 SOL) to pay the real network fee...");
    let airdropOk = false;
    let airdropError = null;
    let balanceBeforeExecuteLamports = null;

    try{
        const airdropSig = await connection.requestAirdrop(walletPubkey, 0.05 * 1e9);
        const latest = await connection.getLatestBlockhash();
        await connection.confirmTransaction({ signature: airdropSig, ...latest }, "confirmed");
        balanceBeforeExecuteLamports = await connection.getBalance(walletPubkey);
        airdropOk = true;
        console.log(`Airdrop confirmed: ${airdropSig} - trading wallet now holds ${balanceBeforeExecuteLamports} lamports.`);
    }
    catch(err){
        airdropError = err.message;
        console.error(`Airdrop failed: ${err.message}`);
    }

    // Run the real pipeline against real devnet regardless of whether
    // funding succeeded - an unfunded wallet is a legitimate real-world
    // case (see Task 6's balance validation), and running it here
    // proves the real balanceValidationService/PREPARING fail-closed
    // path against a REAL RPC response (a genuine 0-lamport balance),
    // not a simulated one.
    console.log("Running the real pipeline against real devnet: prepare -> validate real balance -> sign -> broadcast -> confirm...");
    const startedAt = Date.now();
    const result = await executionService.execute({
        userId: account.userId,
        walletPublicKey: account.tradingWalletPublicKey,
        action: "FOUNDER_DRY_RUN"
    });
    const elapsedMs = Date.now() - startedAt;

    const execution = executionRepository.findById(account.userId, result.executionId);
    const log = executionRepository.findLogByExecutionId(result.executionId);

    console.log(`Outcome: ${result.outcome} in ${elapsedMs}ms (execution #${result.executionId})`);
    log.forEach(row => console.log(`  [${row.log_type}] ${row.from_status ?? ""} -> ${row.to_status ?? ""} ${row.message ?? ""} ${row.latency_ms != null ? `(${row.latency_ms}ms)` : ""}`));

    if(execution.tx_hash){
        console.log(`Real transaction: https://explorer.solana.com/tx/${execution.tx_hash}?cluster=devnet`);
    }

    if(!airdropOk){
        console.log("NOTE: the devnet faucet was rate-limited this session (see airdropError above) - the run above is real-RPC/real-balance-check/real-fail-closed-path verification against an UNFUNDED wallet, not a full funded SUCCESS. See the report for what this does and does not prove.");
    }

    cleanUp(harness);

    const summary = {
        task: 1,
        network: "devnet",
        airdropOk,
        airdropError,
        account: { userId: account.userId, tradingWalletPublicKey: account.tradingWalletPublicKey },
        balanceBeforeExecuteLamports,
        outcome: result?.outcome ?? null,
        executionId: result?.executionId ?? null,
        elapsedMs,
        txHash: execution?.tx_hash ?? null,
        logRowCount: log.length,
        confirmationResult: execution?.confirmation_result_json ? JSON.parse(execution.confirmation_result_json) : null
    };

    console.log("===RESULT_JSON===");
    console.log(JSON.stringify(summary, null, 2));

    process.exitCode = airdropOk && result?.outcome === "SUCCESS" ? 0 : 1;

}

main().catch((err) => {
    console.error("FATAL:", err);
    cleanUp(harness);
    process.exitCode = 1;
});
