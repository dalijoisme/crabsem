// services/execution/selfTransferTransactionBuilder.js - Sprint 1's
// ONLY transactionBuilder: a harmless 0-lamport transfer from the
// trading wallet to itself. It exists purely to give
// executionService.js a real, real-chain-shaped Transaction to sign/
// broadcast/confirm so the full pipeline can be proven end-to-end
// without any actual BUY/SELL/swap logic (explicitly out of scope this
// sprint).
//
// This is the seam Sprint 2 extends, not replaces: a
// gmgnSwapTransactionBuilder.js implementing the exact same
// `build({ userId, walletPublicKey, action, amountLamports, tokenAddress })`
// shape can be swapped in wherever this one is injected today, with
// zero changes to executionService.js or anything downstream of it.

const { SystemProgram, PublicKey, Transaction } = require("@solana/web3.js");

/**
 * @typedef {object} TransactionBuilder
 * @property {(params: { userId: number, walletPublicKey: string, action: string, amountLamports: number|null, tokenAddress: string|null }) => Promise<import("@solana/web3.js").Transaction>} build
 */

/**
 * @returns {TransactionBuilder}
 */
function createSelfTransferTransactionBuilder(){

    // async even though nothing here awaits anything - every real
    // builder (Sprint 2's GMGN/Jupiter one included) will need to be
    // async (quote lookups, route-building calls), so this keeps the
    // interface stable rather than needing a breaking change later.
    async function build({ walletPublicKey }){

        const owner = new PublicKey(walletPublicKey);
        const transaction = new Transaction();

        transaction.feePayer = owner;
        transaction.add(SystemProgram.transfer({
            fromPubkey: owner,
            toPubkey: owner,
            lamports: 0
        }));

        return transaction;

    }

    return { build };

}

module.exports = { createSelfTransferTransactionBuilder };
