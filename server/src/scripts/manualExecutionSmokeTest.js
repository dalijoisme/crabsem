// scripts/manualExecutionSmokeTest.js - manual, hand-run proof that
// the Execution Layer foundation (Sprint 1) actually works against a
// real Solana cluster, end to end: decrypt wallet -> sign -> broadcast
// -> confirm -> logged. Uses the exact same production wiring
// (services/execution/index.js) every real route will eventually use -
// this is not a separate/parallel test harness.
//
// Runs the harmless selfTransferTransactionBuilder.js (a 0-lamport
// self-transfer) - never a real BUY/SELL/swap (out of scope this
// sprint). NOT imported by any route, scheduler, or server/src/index.js -
// this file only ever runs when an engineer invokes it directly.
//
// Point SOLANA_RPC_URL (server/.env) at a real DEVNET endpoint before
// running this - never mainnet, this is a manual smoke test, not a
// real trade.
//
// Usage: node src/scripts/manualExecutionSmokeTest.js <userId>

const config = require("../config/env");
const { executionService, executionRepository, tradingWalletRepository } = require("../services/execution");

const [, , userIdArg] = process.argv;
const userId = Number(userIdArg);

if(!userIdArg || !Number.isInteger(userId)){
    console.error("Usage: node src/scripts/manualExecutionSmokeTest.js <userId>");
    process.exit(1);
}

if(!config.SOLANA_RPC_URL){
    console.error("SOLANA_RPC_URL is not set in server/.env - set it to a real DEVNET endpoint before running this script.");
    process.exit(1);
}

async function main(){

    const wallet = tradingWalletRepository.findByUserId(userId);
    if(!wallet){
        console.error(`No Trading Wallet found for user ${userId} - generate one first (POST /api/v1/wallet/trading-wallet/generate) and fund it with real devnet SOL.`);
        process.exit(1);
    }

    console.log(`[smoke-test] Trading wallet: ${wallet.public_key}`);
    console.log(`[smoke-test] RPC endpoint:   ${config.SOLANA_RPC_URL}`);
    console.log("[smoke-test] Running a harmless 0-lamport self-transfer through the real execution pipeline...");

    const result = await executionService.execute({
        userId,
        walletPublicKey: wallet.public_key,
        action: "MANUAL_SMOKE_TEST"
    });

    console.log(`[smoke-test] Final outcome: ${result.outcome} (execution #${result.executionId})`);

    const execution = executionRepository.findById(userId, result.executionId);
    console.log("[smoke-test] Execution row:", execution);

    const log = executionRepository.findLogByExecutionId(result.executionId);
    console.log(`[smoke-test] ${log.length} log row(s):`);
    log.forEach(row => console.log(`  [${row.log_type}] ${row.from_status ?? ""} -> ${row.to_status ?? ""} ${row.message ?? ""}`));

    process.exit(result.outcome === "SUCCESS" ? 0 : 1);

}

main().catch((err) => {
    console.error("[smoke-test] Unexpected error:", err);
    process.exit(1);
});
