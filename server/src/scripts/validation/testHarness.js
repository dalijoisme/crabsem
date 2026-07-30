// scripts/validation/testHarness.js - Sprint 1.5 (Founder Dry Run
// Validation) shared setup. Every script in this folder uses an
// ISOLATED, temporary SQLite database - NEVER server/data/crabsem.sqlite -
// so 100+ stress-test executions and deliberately-induced crash/failure
// scenarios can never touch real founder data.
//
// process.env.DB_PATH must be set BEFORE the first require() of
// config/env.js or database/connection.js anywhere in the process
// (Node's module cache means whichever value is set first wins for the
// life of the process) - which is why setUpIsolatedDatabase() is a
// synchronous, side-effecting call every script in this folder makes
// as its very first line, before requiring anything else.
//
// This file adds no new production capability - it only assembles real,
// already-existing modules (database/migrate.js, repositories/userRepository.js,
// services/walletService.js) into a repeatable "fresh founder account"
// fixture, the same way the Sprint 1 unit tests assemble fakes.

const fs = require("fs");
const path = require("path");
const os = require("os");
const nacl = require("tweetnacl");
const { Keypair } = require("@solana/web3.js");

function setUpIsolatedDatabase(){
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crab-sprint1.5-"));
    const dbPath = path.join(dir, "validation.sqlite");
    process.env.DB_PATH = dbPath;
    return { dir, dbPath };
}

// Real devnet is the default (Task 1's literal ask - a real dry run).
// Tasks 2-7 override this with a harmless placeholder since they inject
// their own simulatedConnectionProvider.js directly and never let
// solanaConnectionProvider.js construct a real Connection at all.
function configureRpc(url){
    process.env.SOLANA_RPC_URL = url || "https://api.devnet.solana.com";
    process.env.SOLANA_COMMITMENT = process.env.SOLANA_COMMITMENT || "confirmed";
    process.env.EXECUTION_CONFIRMATION_TIMEOUT_MS = process.env.EXECUTION_CONFIRMATION_TIMEOUT_MS || "60000";
    process.env.EXECUTION_CONFIRMATION_POLL_INTERVAL_MS = process.env.EXECUTION_CONFIRMATION_POLL_INTERVAL_MS || "2000";
}

function cleanUp({ dir }){
    try{ fs.rmSync(dir, { recursive: true, force: true }); }
    catch(e){ /* best-effort - a leftover temp dir is not a correctness problem */ }
}

// Applies every real migration (001-045) to the isolated DB, then seeds
// ONE real founder-shaped account through the REAL flow: register ->
// connect Owner Wallet -> sign+verify the real ownership challenge ->
// generate a real Trading Wallet. The resulting trading_wallets row is
// genuinely AES-256-GCM-encrypted the exact same way production does
// it (services/walletService.js's own encryptSecretKey - never
// duplicated or shortcut here).
async function seedFounderAccount(label){

    const { runMigrations } = require("../../database/migrate");
    runMigrations();

    const userRepository = require("../../repositories/userRepository");
    const walletService = require("../../services/walletService");

    const userId = userRepository.insertUser({
        email: `${label}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@sprint1-5.invalid`,
        passwordHash: "sprint1.5-validation-only:not-a-real-login",
        fullName: `Sprint 1.5 ${label}`
    });

    const ownerKeypair = Keypair.generate();
    const connectResult = walletService.connectWallet(userId, ownerKeypair.publicKey.toBase58());
    if(!connectResult.ok) throw new Error(`seedFounderAccount: connectWallet failed - ${connectResult.details}`);

    const challenge = walletService.issueOwnershipChallenge(userId);
    const signatureBytes = nacl.sign.detached(Buffer.from(challenge.message, "utf8"), ownerKeypair.secretKey);
    const signature = Buffer.from(signatureBytes).toString("base64");

    const verifyResult = walletService.verifyOwnership(userId, { message: challenge.message, checksum: challenge.checksum, signature });
    if(!verifyResult.ok) throw new Error(`seedFounderAccount: verifyOwnership failed - ${verifyResult.details}`);

    const tradingWalletResult = walletService.generateTradingWallet(userId);
    if(!tradingWalletResult.ok) throw new Error(`seedFounderAccount: generateTradingWallet failed - ${tradingWalletResult.details}`);

    return {
        userId,
        ownerPublicKey: ownerKeypair.publicKey.toBase58(),
        tradingWalletPublicKey: tradingWalletResult.publicKey
    };

}

// Assembles a real executionService (real repository, real signing
// service, real logger, real selfTransferTransactionBuilder - nothing
// mocked except the one seam that's meant to be swappable: the
// connectionProvider). Every Sprint 1.5 script that validates pipeline
// LOGIC rather than real network behavior calls this with a
// simulatedConnectionProvider.js instance instead of duplicating
// services/execution/index.js's wiring - one place assembles the
// "real service, fake chain" combination, matching the DI seam the
// modules were already built with.
function buildExecutionServiceWithProvider(connectionProvider, overrides = {}){

    const executionRepository = require("../../repositories/executionRepository");
    const tradingWalletRepository = require("../../repositories/tradingWalletRepository");
    const walletService = require("../../services/walletService");

    const { createTransactionSigningService } = require("../../services/execution/transactionSigningService");
    const { createBalanceValidationService } = require("../../services/execution/balanceValidationService");
    const { createTransactionConfirmationService } = require("../../services/execution/transactionConfirmationService");
    const { createSelfTransferTransactionBuilder } = require("../../services/execution/selfTransferTransactionBuilder");
    const { createExecutionLogger } = require("../../services/execution/executionLogger");
    const { createExecutionService } = require("../../services/execution/executionService");

    // overrides.signingService lets a script wrap the real signing
    // service with a call-counting spy (see task3_crashRecovery.js) -
    // exactly the DI seam these modules were built for; nothing here
    // duplicates transactionSigningService.js's own logic to do that.
    const signingService = overrides.signingService ?? createTransactionSigningService({ walletService, tradingWalletRepository });
    const balanceService = createBalanceValidationService(connectionProvider);
    const confirmationService = createTransactionConfirmationService(connectionProvider, {
        timeoutMs: Number(process.env.EXECUTION_CONFIRMATION_TIMEOUT_MS) || 60000,
        pollIntervalMs: Number(process.env.EXECUTION_CONFIRMATION_POLL_INTERVAL_MS) || 2000
    });
    const transactionBuilder = createSelfTransferTransactionBuilder();
    const logger = createExecutionLogger(executionRepository);

    const executionService = createExecutionService({
        repository: executionRepository,
        connectionProvider,
        signingService,
        balanceService,
        confirmationService,
        transactionBuilder,
        logger
    });

    return { executionService, executionRepository, tradingWalletRepository };

}

module.exports = { setUpIsolatedDatabase, configureRpc, cleanUp, seedFounderAccount, buildExecutionServiceWithProvider };
