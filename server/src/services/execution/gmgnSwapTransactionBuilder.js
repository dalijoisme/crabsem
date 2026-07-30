// services/execution/gmgnSwapTransactionBuilder.js - the Sprint 2
// bridge, now complete under the confirmed, founder-approved custody
// model: GMGN executes server-side (Path A - Founder Decision).
//
// Implements the same build({ userId, walletPublicKey, action,
// amountLamports, tokenAddress }) interface every transactionBuilder
// uses, but returns a different SHAPE than selfTransferTransactionBuilder.js
// does: instead of an unsigned Transaction object, it returns a
// { __custodialExecution: true, submit } marker. executionService.js
// checks for this marker and, when present, skips the local
// signingService.sign() call and the local sendRawTransaction() call -
// there is nothing local to sign, because GMGN signs and broadcasts
// server-side. This is confirmed directly from GMGN's own official
// reference implementation, not assumed:
//   - OpenApiClient.ts's entire swap() method is one line -
//     `return this.authSignedRequest("POST", "/v1/trade/swap", {}, params)` -
//     no transaction construction, no signing, no broadcast logic.
//   - That file imports zero blockchain SDK anywhere.
//   - config.ts (the CLI's entire local credential surface) only ever
//     holds GMGN_API_KEY/GMGN_PRIVATE_KEY (the API-request-signing key,
//     confirmed by GMGN's own docs to NOT be a blockchain wallet key) -
//     no wallet keypair, no wallet import/bind command exists anywhere
//     in the reference tool.
// See the Sprint 2 final report for the full evidence trail.
//
// transactionSigningService.js is NOT modified and NOT removed - it
// stays exactly as built, for any future execution provider that DOES
// return a locally-signable transaction (selfTransferTransactionBuilder.js
// still uses it today, in tests and the manual devnet smoke test).

const { assertFounderWallet } = require("./founderModeGuard");
const { assertQuoteIsSafeToExecute } = require("./executionGuard");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const CHAIN = "sol";
const DEFAULT_SLIPPAGE_PCT = 10;

/**
 * @typedef {object} GmgnSwapTransactionBuilderDeps
 * @property {ReturnType<import("../../collectors/gmgn/authClient").createGmgnClient>} gmgnClient
 * @property {{ FOUNDER_WALLET_PUBLIC_KEY: string|null }} config
 * @property {import("./executionGuard").ExecutionGuardLimits} [guardLimits]
 */

/**
 * @param {GmgnSwapTransactionBuilderDeps} deps
 */
function createGmgnSwapTransactionBuilder({ gmgnClient, config, guardLimits = {} }){

    /**
     * @param {object} params
     * @param {number} params.userId
     * @param {string} params.walletPublicKey
     * @param {"BUY"|"SELL"} params.action
     * @param {number|null} params.amountLamports - the base-unit amount of whatever's being SPENT (SOL lamports for BUY, the token's own base units for SELL)
     * @param {string|null} params.tokenAddress
     */
    async function build({ userId, walletPublicKey, action, amountLamports, tokenAddress }){

        // 1. Founder Mode - cheapest possible check, before any network call.
        assertFounderWallet(config, walletPublicKey);

        if(!tokenAddress){
            throw new Error("gmgnSwapTransactionBuilder: tokenAddress is required for a real swap (BUY needs an output token, SELL needs an input token).");
        }
        if(!amountLamports || amountLamports <= 0){
            throw new Error("gmgnSwapTransactionBuilder: amountLamports must be a positive base-unit amount.");
        }

        const isBuy = action === "BUY";
        const isSell = action === "SELL";
        if(!isBuy && !isSell){
            throw new Error(`gmgnSwapTransactionBuilder: unsupported action "${action}" - only BUY and SELL are real swaps.`);
        }

        const inputToken = isBuy ? SOL_MINT : tokenAddress;
        const outputToken = isBuy ? tokenAddress : SOL_MINT;
        const slippage = guardLimits.maxSlippagePct ?? DEFAULT_SLIPPAGE_PCT;

        // 2. Real GMGN quote - read-only, confirmed live, API-key-only auth.
        const { data: quote } = await gmgnClient.getSwapQuote(CHAIN, {
            inputToken,
            outputToken,
            fromAddress: walletPublicKey,
            inputAmount: String(amountLamports),
            slippage
        });

        // 3. Execution Guard - price impact / slippage / route quality,
        // facts about THIS specific quote, checked before anything real happens.
        assertQuoteIsSafeToExecute(quote, guardLimits);

        // 4. Nothing irreversible has happened yet - build() only
        // validates. The actual state-changing POST /v1/trade/swap call
        // is deferred to submit(), called by executionService.js during
        // its SUBMITTING transition (the same point sendRawTransaction()
        // would fire for a locally-signed provider) - preserving the
        // exact crash-safety semantics the state machine was built
        // around: PREPARING can safely fail or be retried, because
        // nothing real has been submitted until SUBMITTING.
        return {

            __custodialExecution: true,

            async submit(){

                const { data } = await gmgnClient.submitSwap(CHAIN, {
                    fromAddress: walletPublicKey,
                    inputToken,
                    outputToken,
                    inputAmount: String(amountLamports),
                    slippage
                });

                if(!data?.hash){
                    throw new Error("gmgnSwapTransactionBuilder: GMGN swap response did not include a transaction hash.");
                }

                return {
                    txHash: data.hash,
                    orderId: data.order_id ?? null,
                    providerStatus: data.status ?? null
                };

            }

        };

    }

    return { build };

}

module.exports = { createGmgnSwapTransactionBuilder, SOL_MINT, CHAIN };
