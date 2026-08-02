// services/execution/transactionBalanceReader.js - Arjuna V4 (Sprint 11),
// Part 1. The fix for the gap executionService.js's own header comment
// already documented ("no real on-chain fill price is captured
// anywhere... Deliberately deferred"): reads the REAL, confirmed
// transaction's own pre/post SOL and SPL-token balances for the trading
// wallet - the actual thing that moved on-chain, never a quote/estimate.
// Read-only (getParsedTransaction never sends anything) - same
// "narrow specialist, real chain read" shape as balanceValidationService.js.

const { PublicKey } = require("@solana/web3.js");

/**
 * @typedef {object} ActualSwapAmounts
 * @property {number|null} solDeltaLamports - signed: negative = SOL left the wallet (a BUY), positive = SOL arrived (a SELL)
 * @property {number|null} tokenDeltaUi - signed, in the token's own UI units: positive = tokens arrived (a BUY), negative = tokens left (a SELL)
 * @property {number|null} blockTime - real Unix seconds the transaction actually landed, from the chain itself
 * @property {number|null} slot
 */

/**
 * @param {import("./solanaConnectionProvider").SolanaConnectionProvider} connectionProvider
 */
function createTransactionBalanceReader(connectionProvider){

    /**
     * @param {string} signature - a real, already-confirmed transaction signature
     * @param {string} walletAddress - the trading wallet's own public key
     * @param {string|null} tokenMint - the SPL token mint involved (null skips the token-balance read, e.g. not needed)
     * @returns {Promise<ActualSwapAmounts|null>} null when the transaction/wallet account can't be found (never fabricated)
     */
    async function readActualSwapAmounts(signature, walletAddress, tokenMint = null){

        const connection = connectionProvider.getConnection();
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });

        if(!tx || !tx.meta) return null;

        const accountKeys = tx.transaction.message.accountKeys.map(k => (k.pubkey ? k.pubkey.toString() : String(k)));
        const walletIndex = accountKeys.indexOf(walletAddress);

        let solDeltaLamports = null;
        if(walletIndex !== -1 && tx.meta.preBalances?.[walletIndex] != null && tx.meta.postBalances?.[walletIndex] != null){
            solDeltaLamports = tx.meta.postBalances[walletIndex] - tx.meta.preBalances[walletIndex];
        }

        let tokenDeltaUi = null;
        if(tokenMint){
            const preEntry = (tx.meta.preTokenBalances || []).find(b => b.owner === walletAddress && b.mint === tokenMint);
            const postEntry = (tx.meta.postTokenBalances || []).find(b => b.owner === walletAddress && b.mint === tokenMint);
            const preAmount = preEntry ? Number(preEntry.uiTokenAmount?.uiAmount ?? 0) : 0;
            const postAmount = postEntry ? Number(postEntry.uiTokenAmount?.uiAmount ?? 0) : 0;
            // A real pre/post reading exists as long as EITHER side had an
            // account entry - a token account that only appears post-swap
            // (a fresh BUY) or only pre-swap (a full SELL closing the
            // account) is still a real, computable delta, never "no data".
            if(preEntry || postEntry) tokenDeltaUi = postAmount - preAmount;
        }

        return {
            solDeltaLamports,
            tokenDeltaUi,
            blockTime: tx.blockTime ?? null,
            slot: tx.slot ?? null
        };

    }

    return { readActualSwapAmounts };

}

module.exports = { createTransactionBalanceReader };
