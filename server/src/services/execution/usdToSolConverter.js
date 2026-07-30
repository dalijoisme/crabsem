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

const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CHAIN = "sol";

// A fixed, deliberately round reference amount for the PRICE lookup
// itself - big enough that GMGN's own price-impact on the pricing side
// is negligible, small enough it never resembles a real position size.
// This is a price probe, not a trade.
const REFERENCE_SOL_AMOUNT = 1;

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

    return amountInUsd / REFERENCE_SOL_AMOUNT;

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
    USDC_MINT
};
