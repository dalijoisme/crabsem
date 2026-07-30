// services/execution/solanaConnectionProvider.js - the ONE place in
// the whole codebase that constructs a @solana/web3.js Connection
// (verified before writing this file: no `new Connection(` existed
// anywhere in server/src before the Execution Layer foundation sprint).
// Every other execution-layer module receives a connection PROVIDER as
// a constructor dependency, never `require`s this file's Connection
// directly and never imports @solana/web3.js's Connection class itself -
// that's what makes balanceValidationService.js/
// transactionConfirmationService.js/executionService.js testable with a
// hand-written fake instead of a real RPC endpoint.
//
// config.SOLANA_RPC_URL is null by default (fails closed, same
// convention as ADMIN_PASSWORD/GMGN_API_KEY) - deliberately NOT a
// public-cluster fallback, since a public RPC is rate-limited and
// unsuitable for anything this layer will eventually do with real
// funds.

/**
 * @typedef {object} SolanaConnectionProvider
 * @property {() => import("@solana/web3.js").Connection} getConnection
 * @property {() => string} getEndpoint
 */

/**
 * @param {{ SOLANA_RPC_URL: string|null, SOLANA_COMMITMENT: string }} config
 * @returns {SolanaConnectionProvider}
 */
function createSolanaConnectionProvider(config){

    if(!config.SOLANA_RPC_URL){
        // Fails closed at USE time, not at require() time - requiring
        // this module (e.g. transitively, at app startup) must never
        // itself crash the process just because no RPC is configured
        // yet; only actually trying to use the connection should.
        return {
            getConnection(){
                throw new Error("solanaConnectionProvider: SOLANA_RPC_URL is not configured - the execution layer is disabled. Set a real RPC endpoint in server/.env to enable it.");
            },
            getEndpoint(){
                return null;
            }
        };
    }

    // Lazy + cached: constructed on first real use, reused after that -
    // avoids paying connection setup cost for processes that never
    // touch the execution layer (e.g. a test run, or a boot with no
    // pending executions to reconcile).
    let connection = null;

    function getConnection(){
        const { Connection } = require("@solana/web3.js");
        if(!connection){
            connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_COMMITMENT);
        }
        return connection;
    }

    function getEndpoint(){
        return config.SOLANA_RPC_URL;
    }

    return { getConnection, getEndpoint };

}

module.exports = { createSolanaConnectionProvider };
