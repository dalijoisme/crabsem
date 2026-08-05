// services/execution/usdToSolConverter.js - the ONLY place a USD
// position size becomes on-chain SOL lamports. Isolated on purpose:
// Production V2, the risk engine, and every USD-denominated number in
// trading_bot_config/trading_bot_positions stay exactly as they are -
// this module is the one seam where a dollar amount turns into a real
// Solana unit, right before it reaches gmgnSwapTransactionBuilder.js.
//
//   USD Position Size -> Current SOL/USD Price -> SOL Amount -> Lamports
//
// SOL/USD price is not a new price feed - it's read from GMGN's own
// already-integrated GET /v1/trade/quote (a real, live quote for a
// fixed, small SOL -> USDC amount), the exact same method
// gmgnSwapTransactionBuilder.js already uses for every real trade
// quote. No new endpoint, no new external dependency, no fabricated
// number - quote already returns a real amount_in_usd field for
// whatever amount is asked, confirmed live during Sprint 2 planning.
//
// GMGN request-volume audit (follow-up to the Held-Position Refresh
// sprint): getSolUsdPrice is a PRICE PROBE, not a real trade - but before
// this fix it had zero caching/coalescing, and is called from 6+
// independent sites (services/walletService.js's getRealWalletBalance,
// reached from getDecisionCenter/getTradingConfiguration/getStatus/
// startBot/setAllocation/resetTradingCapital, AND
// scheduler/walletBalanceSyncScheduler.js). The dominant real-world
// source: js/tradingBot.js's dashboard polls GET /tradingbot/decision-center
// every 15s (LIVE_REFRESH_INTERVAL_MS) for as long as any admin tab stays
// open - a live GMGN quote fetched purely to display a number (SOL/USD)
// that barely moves within 15s and, confirmed by this file's own quote
// call below, is IDENTICAL regardless of which wallet address asks for
// it. walletBalanceSyncScheduler.js then independently re-fetches that
// SAME global number again, once per user, every 5 minutes. These
// GET /v1/trade/quote requests are what show up in logs as tickId:null -
// they never come from inside scheduler/gmgnTrendingScheduler.js (none
// of its 7 registered collectors ever call getSwapQuote - confirmed by
// grep). When one of these happens to land while that scheduler's own
// tick is in progress, collectors/gmgn/requestDiagnostics.js's tick-
// tagging state (currentTickId/sequenceInTick) is process-global, not
// scoped to the scheduler's own call stack, so the unrelated quote
// request gets mislabeled with that tick's id - a diagnostic-logging
// artifact, not a second real caller inside the scheduler.
//
// Fix: getSolUsdPrice caches its result for PRICE_CACHE_TTL_MS and
// coalesces concurrent callers into one shared in-flight fetch - exactly
// the same "shared cache + request coalescing" pattern already applied
// to held-position refresh, scoped to this one price-probe function.
// gmgnSwapTransactionBuilder.js's own getSwapQuote calls (real BUY/SELL
// execution, in services/execution/gmgnSwapTransactionBuilder.js) are
// NOT touched by this cache - those must always reflect the live market
// at the moment of a real trade and stay on execution's own, separate,
// uncached gmgnClient instance.

const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CHAIN = "sol";

// A fixed, deliberately round reference amount for the PRICE lookup
// itself - big enough that GMGN's own price-impact on the pricing side
// is negligible, small enough it never resembles a real position size.
// This is a price probe, not a trade.
const REFERENCE_SOL_AMOUNT = 1;

// Shorter than js/tradingBot.js's own LIVE_REFRESH_INTERVAL_MS (15000) -
// a fresh price is still fetched every dashboard poll tick, this only
// collapses (a) the near-simultaneous calls two different endpoints hit
// within the SAME poll tick (getDecisionCenter + getTradingConfiguration
// on initial load), and (b) walletBalanceSyncScheduler.js's own
// per-user loop, since the price is the same for every user. Never a
// wider staleness window than a dashboard refresh already implies.
const PRICE_CACHE_TTL_MS = 10000;

// Module-level, deliberately NOT per-fromAddress - confirmed below
// (and by this file's own long-standing comment) that GMGN's quote
// returns the same amount_in_usd regardless of which address asks, so
// one shared cache/in-flight-fetch correctly serves every caller.
let cachedPrice = null;
let cachedAt = 0;
let inFlightFetch = null;

/**
 * Real, current USD price of 1 SOL, read from a real GMGN quote.
 * quote is a read-only price lookup and does not need to be the
 * founder's own wallet - confirmed live (Sprint 2 planning) that quote
 * succeeds identically regardless of which address is passed.
 *
 * @param {{ getSwapQuote: Function }} gmgnClient
 * @param {string} fromAddress
 * @returns {Promise<number>}
 */
async function getSolUsdPrice(gmgnClient, fromAddress){

    if(cachedPrice != null && (Date.now() - cachedAt) <= PRICE_CACHE_TTL_MS){
        return cachedPrice;
    }

    // Concurrent callers within the same stale/cold window share ONE
    // real fetch - never a cache once settled (success or failure), the
    // next call after this resolves goes live again unless the TTL
    // check above already caught it.
    if(inFlightFetch) return inFlightFetch;

    inFlightFetch = (async () => {

        try{

            const { data: quote } = await gmgnClient.getSwapQuote(CHAIN, {
                inputToken: SOL_MINT,
                outputToken: USDC_MINT,
                fromAddress,
                inputAmount: String(REFERENCE_SOL_AMOUNT * LAMPORTS_PER_SOL),
                slippage: 1
            });

            const amountInUsd = Number(quote?.tx?.amount_in_usd);
            if(!amountInUsd || amountInUsd <= 0){
                throw new Error("usdToSolConverter: GMGN quote did not return a usable amount_in_usd - cannot price SOL right now.");
            }

            const price = amountInUsd / REFERENCE_SOL_AMOUNT;
            cachedPrice = price;
            cachedAt = Date.now();
            return price;

        }
        finally{
            inFlightFetch = null;
        }

    })();

    return inFlightFetch;

}

// Test-only reset - same convention as services/heldPositionMarketStore.js's
// clear()/services/marketDataGateway.js's _resetForTest().
function _resetPriceCacheForTest(){
    cachedPrice = null;
    cachedAt = 0;
    inFlightFetch = null;
}

/**
 * Pure math, no I/O - kept separate from getSolUsdPrice() so the
 * conversion arithmetic itself is testable with zero network
 * dependency, and so a fresh price never has to be re-fetched for a
 * caller that already has one.
 *
 * @param {number} usdAmount
 * @param {number} solUsdPrice
 * @returns {number} lamports, rounded DOWN - never round up what's about to be spent
 */
function usdToLamports(usdAmount, solUsdPrice){

    if(!(usdAmount > 0)) throw new Error("usdToSolConverter: usdAmount must be a positive number.");
    if(!(solUsdPrice > 0)) throw new Error("usdToSolConverter: solUsdPrice must be a positive number.");

    const solAmount = usdAmount / solUsdPrice;
    return Math.floor(solAmount * LAMPORTS_PER_SOL);

}

/**
 * The full USD -> lamports pipeline in one call.
 * @param {{ getSwapQuote: Function }} gmgnClient
 * @param {string} fromAddress
 * @param {number} usdAmount
 * @returns {Promise<{ lamports: number, solUsdPrice: number }>}
 */
async function convertUsdPositionToLamports(gmgnClient, fromAddress, usdAmount){
    const solUsdPrice = await getSolUsdPrice(gmgnClient, fromAddress);
    const lamports = usdToLamports(usdAmount, solUsdPrice);
    return { lamports, solUsdPrice };
}

module.exports = {
    getSolUsdPrice,
    usdToLamports,
    convertUsdPositionToLamports,
    LAMPORTS_PER_SOL,
    SOL_MINT,
    USDC_MINT,
    PRICE_CACHE_TTL_MS,
    _resetPriceCacheForTest
};
