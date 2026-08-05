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
const executionSafetyConfig = require("../../config/executionSafetyConfig");
// RATE_LIMIT_BANNED investigation, round 2: tags every real quote/submit
// call with its own origin - see gmgnTrafficAccounting.js's own header.
const { withOrigin } = require("../../collectors/gmgn/gmgnTrafficAccounting");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const CHAIN = "sol";
const DEFAULT_SLIPPAGE_PCT = executionSafetyConfig.buyDefaultSlippagePct;

// FINAL PRODUCTION SPRINT P0 (superseded below, history kept for
// context) - root cause of "Stop Loss identified the exit but the
// position stayed OPEN". executionGuard.js's price-impact/slippage/
// route-hop ceilings exist to protect a BUY from being tricked into
// thin/fake liquidity - a genuinely discretionary decision about
// whether to take on NEW risk. A SELL triggered by Dynamic Exit is the
// opposite kind of decision: the risk is already owned, and a blocked
// exit doesn't reduce risk, it just prolongs exposure (Incident A).
// The original P0 fix solved this by skipping all three ceilings
// entirely (Infinity) for SELL - but that traded Incident A for
// Incident B: a real, on-chain-measured production finding (realized
// settlement 98.7-99.3% worse than quoted, worst at TP1/TP2) showing an
// unlimited tolerance accepts catastrophic fills the market didn't
// actually require.
//
// Execution Safety Project - replaces the single Infinity override with
// a bounded, ESCALATING tolerance (EXIT_TOLERANCE_TIERS below), not a
// single fixed ceiling. Tier 1 gives a real, protective price-impact
// ceiling for the ordinary case - and catches exactly the failure modes
// where a second, fresh quote has a real chance of being meaningfully
// better than the first (a momentarily stale quote, a transient MEV/
// sandwich dislocation, a large-but-recoverable spread). If tier 1's
// quote is outside that ceiling, exactly ONE more attempt is made at a
// wider tolerance (tier 2, using the same EXIT_SLIPPAGE_REQUEST_PCT
// this file already used for every SELL before this project - reused,
// not reinvented). If BOTH real tiers fail, execution falls through to
// unconditional acceptance - the exact behaviour this file had before
// this project - so a genuine, sustained collapse can never leave a
// position permanently stuck. Incident A never regresses; Incident B is
// bounded rather than unlimited for the common case. The hard sanity
// checks inside assertQuoteIsSafeToExecute (a real route exists, output
// amount positive) are never bypassed at any tier - a quote with
// literally no route cannot be submitted regardless. BUY is completely
// untouched - same 5%/15%/3-hop ceilings as before, single quote
// attempt, no tiering; Arjuna's entry risk posture is not part of this
// project.
// Release Validation project - the tier numbers themselves now live in
// config/executionSafetyConfig.js (checklist item 9: no production
// tuning value hardcoded inside business logic). Escalation is bounded
// to exactly these real tiers, then falls through - never a blind/
// unbounded retry loop.
const EXIT_TOLERANCE_TIERS = executionSafetyConfig.exitToleranceTiers;

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

        let quote, slippage;
        // Release Validation project, checklist item 6/7 (logging/metrics):
        // which tier a SELL actually resolved at is now surfaced on the
        // returned object (executionTier below) so executionService.js
        // can log it through the SAME real RPC-log call it already makes
        // at the SUBMITTING step - no new logging plumbing, no new
        // trading logic, purely observability.
        let executionTier = isBuy ? null : "FALLBACK";

        if(isBuy){

            // BUY - completely untouched: one quote, one check, BUY's own
            // existing guardLimits (default 5%/15%/3-hop), never bypassed.
            slippage = guardLimits.maxSlippagePct ?? DEFAULT_SLIPPAGE_PCT;
            const { data } = await withOrigin("execution:buy-quote", () => gmgnClient.getSwapQuote(CHAIN, {
                inputToken, outputToken, fromAddress: walletPublicKey,
                inputAmount: String(amountLamports), slippage
            }));
            assertQuoteIsSafeToExecute(data, guardLimits);
            quote = data;

        }
        else{

            // SELL - bounded, escalating tiers (see EXIT_TOLERANCE_TIERS'
            // own header for the full reasoning). Real route-hop bypass
            // (Infinity) is unchanged from before this project - Sprint
            // 22's finding was about price, not route complexity, and the
            // hard sanity check (a real route exists at all) is never
            // bypassed at any tier regardless.
            let lastQuote = null, accepted = false;

            for(let i = 0; i < EXIT_TOLERANCE_TIERS.length; i++){
                const tier = EXIT_TOLERANCE_TIERS[i];
                const { data } = await withOrigin("execution:sell-quote", () => gmgnClient.getSwapQuote(CHAIN, {
                    inputToken, outputToken, fromAddress: walletPublicKey,
                    inputAmount: String(amountLamports), slippage: tier.slippagePct
                }));
                lastQuote = data;
                slippage = tier.slippagePct;
                try{
                    assertQuoteIsSafeToExecute(data, { maxPriceImpactPct: tier.maxPriceImpactPct, maxSlippagePct: tier.slippagePct, maxRouteHops: Infinity });
                    accepted = true;
                    executionTier = `TIER_${i + 1}`;
                    break;
                }
                catch(err){ void err; } // this tier's tolerance wasn't enough - escalate to the next one
            }

            if(!accepted){
                // Both real tiers failed on price-impact/slippage tolerance -
                // fall through to unconditional acceptance, the exact
                // behaviour this file had before this project, so a
                // genuine, sustained collapse can never leave the position
                // stuck. Hard sanity checks (route exists, output positive)
                // still apply unconditionally - if even THOSE fail, this
                // throws for real, same as always. executionTier stays
                // "FALLBACK" (set above) - a real, queryable signal for how
                // often the widest, unconditional path is actually needed.
                assertQuoteIsSafeToExecute(lastQuote, { maxPriceImpactPct: Infinity, maxSlippagePct: Infinity, maxRouteHops: Infinity });
            }

            quote = lastQuote;

        }

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

            // Observability only (Release Validation, checklist item 6/7) -
            // null for BUY (never tiered), "TIER_1"/"TIER_2"/"FALLBACK" for
            // SELL. executionService.js reads this and folds it into the
            // SAME real RPC log it already writes at the SUBMITTING step -
            // no new log call, no new trading logic.
            executionTier,

            async submit(){

                const { data } = await withOrigin("execution:submit-swap", () => gmgnClient.submitSwap(CHAIN, {
                    fromAddress: walletPublicKey,
                    inputToken,
                    outputToken,
                    inputAmount: String(amountLamports),
                    slippage
                }));

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
