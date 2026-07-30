// services/execution/transactionSigningService.js - Trading Wallet ->
// decrypt secret key -> sign transaction -> ready for submission. The
// ONLY module allowed to hold a decrypted trading-wallet secret key in
// memory, and only for the duration of this one function call - it is
// never logged, never returned, never stored, and the buffer holding it
// is zeroed out before this function returns (best-effort scrub;
// Node/V8 doesn't guarantee immediate memory reclamation, but nothing
// past this point still references it).
//
// Reuses services/walletService.js's decryptSecretKey() directly - that
// function's own header comment already reserves it "for the Execution
// Layer sprint's own use (signing a real transaction)". No wrapper
// module was added around it, per that comment.
//
// Does not know what the transaction DOES (swap, transfer, anything
// else) and does not build one - it only signs whatever
// @solana/web3.js Transaction/VersionedTransaction it's handed.

const { Keypair, VersionedTransaction } = require("@solana/web3.js");

/**
 * @typedef {object} TransactionSigningDeps
 * @property {{ decryptSecretKey: (encrypted: string) => Buffer }} walletService
 * @property {{ findByUserId: (userId: number) => { public_key: string, encrypted_private_key: string }|undefined }} tradingWalletRepository
 */

/**
 * @param {TransactionSigningDeps} deps
 */
function createTransactionSigningService({ walletService, tradingWalletRepository }){

    /**
     * @param {number} userId
     * @param {import("@solana/web3.js").Transaction|import("@solana/web3.js").VersionedTransaction} transaction
     * @returns {import("@solana/web3.js").Transaction|import("@solana/web3.js").VersionedTransaction} the same transaction object, now signed
     */
    function sign(userId, transaction){

        const wallet = tradingWalletRepository.findByUserId(userId);

        if(!wallet){
            throw new Error(`transactionSigningService: no trading wallet found for user ${userId}`);
        }

        const secretKey = walletService.decryptSecretKey(wallet.encrypted_private_key);

        try{

            const keypair = Keypair.fromSecretKey(secretKey);

            if(keypair.publicKey.toBase58() !== wallet.public_key){
                // Defensive - the decrypted key must match the public
                // key on record, or something is badly wrong (wrong
                // encryption key, corrupted row) and signing must not
                // proceed silently.
                throw new Error("transactionSigningService: decrypted keypair does not match the trading wallet's recorded public key");
            }

            if(transaction instanceof VersionedTransaction){
                transaction.sign([keypair]);
            }
            else{
                transaction.partialSign(keypair);
            }

            return transaction;

        }
        finally{
            // Best-effort scrub - this is the only buffer in the
            // process holding this user's decrypted secret key, and
            // nothing below this line touches it again.
            secretKey.fill(0);
        }

    }

    return { sign };

}

module.exports = { createTransactionSigningService };
