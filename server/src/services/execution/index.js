// services/execution/index.js - wires the real, production-bound
// instances of every execution-layer module together (real config,
// real repository, real walletService/tradingWalletRepository). The
// ONE place outside the test suite and scripts/manualExecutionSmokeTest.js
// that assembles a live executionService - controllers/executionController.js
// and src/index.js's boot-time reconciliation both require this file
// instead of each re-wiring the same collaborators.
//
// Safe to require even when SOLANA_RPC_URL is unset: solanaConnectionProvider.js
// only throws when a connection is actually USED, not at construction
// time (see its own header comment) - so requiring this file never
// crashes app startup, it just leaves the execution layer inert until
// a real RPC endpoint is configured.

const config = require("../../config/env");
const executionRepository = require("../../repositories/executionRepository");
const tradingWalletRepository = require("../../repositories/tradingWalletRepository");
const walletService = require("../walletService");
const { createGmgnClient } = require("../../collectors/gmgn/authClient");

const { createSolanaConnectionProvider } = require("./solanaConnectionProvider");
const { createTransactionSigningService } = require("./transactionSigningService");
const { createBalanceValidationService } = require("./balanceValidationService");
const { createTransactionConfirmationService } = require("./transactionConfirmationService");
const { createGmgnSwapTransactionBuilder } = require("./gmgnSwapTransactionBuilder");
const { createExecutionLogger } = require("./executionLogger");
const { createExecutionService } = require("./executionService");

const connectionProvider = createSolanaConnectionProvider(config);

const signingService = createTransactionSigningService({ walletService, tradingWalletRepository });

const balanceService = createBalanceValidationService(connectionProvider);

const confirmationService = createTransactionConfirmationService(connectionProvider, {
    timeoutMs: config.EXECUTION_CONFIRMATION_TIMEOUT_MS,
    pollIntervalMs: config.EXECUTION_CONFIRMATION_POLL_INTERVAL_MS,
    commitment: config.SOLANA_COMMITMENT
});

// Sprint 2 seam, now filled: gmgnSwapTransactionBuilder.js has the
// exact same shape selfTransferTransactionBuilder.js (Sprint 1) used,
// so this is the one-line change the DI seam was built for - zero
// changes to executionService.js, the state machine, signing,
// confirmation, logging, or crash recovery.
//
// GMGN client construction is lazy/guarded, not eager - createGmgnClient()
// throws synchronously if GMGN_API_KEY is missing, and this file's own
// header promises it's safe to require with nothing configured (same
// convention as solanaConnectionProvider.js failing closed at USE time,
// not require time).
const gmgnClient = config.GMGN_API_KEY
    ? createGmgnClient({ apiKey: config.GMGN_API_KEY, privateKeyPem: config.GMGN_PRIVATE_KEY, host: config.GMGN_HOST })
    : {
        async getSwapQuote(){ throw new Error("gmgnSwapTransactionBuilder: GMGN_API_KEY is not configured."); },
        async submitSwap(){ throw new Error("gmgnSwapTransactionBuilder: GMGN_API_KEY is not configured."); }
    };

const transactionBuilder = createGmgnSwapTransactionBuilder({ gmgnClient, config });

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

module.exports = {
    executionService,
    balanceService,
    connectionProvider,
    executionRepository,
    tradingWalletRepository,
    // Exported so tradeManager.js/tradingBotEngine.js can reuse the SAME
    // client instance for usdToSolConverter.js's price lookup, instead
    // of constructing a second one - one gmgnClient, one place it's built.
    gmgnClient
};
