// services/execution/balanceValidationService.js - reads REAL on-chain
// balance. Nothing in this file ever accepts a client-supplied balance
// as truth - every method here is a read against the chain itself
// (via the injected connectionProvider, see solanaConnectionProvider.js),
// never a lookup of a locally-cached/self-reported number. This is the
// deliberate fix for the gap the earlier migration audit flagged in the
// old self-reported deposit model (a trust-based, client-supplied
// dollar figure, removed in Production Stabilization V1) - this module
// is what a real balance check should look like, and is what Trading
// Balance is now derived from throughout the app.

const { PublicKey } = require("@solana/web3.js");

/**
 * @typedef {object} SplTokenBalance
 * @property {string} amountRaw - base-unit amount as a string (can exceed Number.MAX_SAFE_INTEGER for some tokens)
 * @property {number|null} decimals
 * @property {number} uiAmount
 */

/**
 * @param {import("./solanaConnectionProvider").SolanaConnectionProvider} connectionProvider
 */
function createBalanceValidationService(connectionProvider){

    /**
     * @param {string} publicKeyBase58
     * @returns {Promise<number>} lamports
     */
    async function getNativeSolBalanceLamports(publicKeyBase58){
        const connection = connectionProvider.getConnection();
        const pubkey = new PublicKey(publicKeyBase58);
        return connection.getBalance(pubkey);
    }

    /**
     * @param {string} publicKeyBase58 - the wallet owner
     * @param {string} mintAddressBase58 - the SPL token mint to check
     * @returns {Promise<SplTokenBalance>}
     */
    async function getSplTokenBalance(publicKeyBase58, mintAddressBase58){
        const connection = connectionProvider.getConnection();
        const owner = new PublicKey(publicKeyBase58);
        const mint = new PublicKey(mintAddressBase58);

        const { value } = await connection.getParsedTokenAccountsByOwner(owner, { mint });

        if(!value.length){
            // No associated token account for this mint is a real,
            // valid answer ("zero balance"), never an error - the
            // wallet may simply never have held this token.
            return { amountRaw: "0", decimals: null, uiAmount: 0 };
        }

        const tokenAmount = value[0].account.data.parsed.info.tokenAmount;

        return {
            amountRaw: tokenAmount.amount,
            decimals: tokenAmount.decimals,
            uiAmount: tokenAmount.uiAmount
        };
    }

    /**
     * @param {string} publicKeyBase58
     * @param {number} requiredLamports
     * @returns {Promise<boolean>}
     */
    async function hasSufficientSolBalance(publicKeyBase58, requiredLamports){
        const balance = await getNativeSolBalanceLamports(publicKeyBase58);
        return balance >= requiredLamports;
    }

    return { getNativeSolBalanceLamports, getSplTokenBalance, hasSufficientSolBalance };

}

module.exports = { createBalanceValidationService };
