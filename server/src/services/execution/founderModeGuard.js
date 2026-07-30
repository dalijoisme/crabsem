// services/execution/founderModeGuard.js - Founder Mode safety lock.
// During Founder Trading (this phase, before Public Alpha), only the
// founder's own Trading Wallet may ever reach signing/broadcast.
// Checked first inside gmgnSwapTransactionBuilder.js, before any GMGN
// API call, so a misconfigured or unexpected caller never spends
// rate-limit budget and never comes near a real transaction.
//
// Fails closed by design - same convention every secret/feature-gate
// in config/env.js already uses (ADMIN_PASSWORD, SOLANA_RPC_URL): if
// FOUNDER_WALLET_PUBLIC_KEY isn't configured, EVERY caller is
// rejected, never just callers who don't match. "Unconfigured" must
// never be read as "open".

/**
 * @param {{ FOUNDER_WALLET_PUBLIC_KEY: string|null }} config
 * @param {string} walletPublicKey
 * @throws {Error} if walletPublicKey isn't the configured Founder Trading Wallet
 */
function assertFounderWallet(config, walletPublicKey){

    if(!config.FOUNDER_WALLET_PUBLIC_KEY){
        throw new Error("founderModeGuard: FOUNDER_WALLET_PUBLIC_KEY is not configured - Founder Mode fails closed, so no wallet may trade until it is set.");
    }

    if(walletPublicKey !== config.FOUNDER_WALLET_PUBLIC_KEY){
        throw new Error(`founderModeGuard: wallet ${walletPublicKey} is not the configured Founder Trading Wallet - rejected.`);
    }

}

module.exports = { assertFounderWallet };
