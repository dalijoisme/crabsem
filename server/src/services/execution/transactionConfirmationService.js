// services/execution/transactionConfirmationService.js - polls the
// chain for a signature's real outcome. Returns exactly one of three
// outcomes, never conflated (see executorStateMachine.js's header for
// why FAILED and TIMEOUT must stay distinct):
//   - SUCCESS: confirmed at/above the required commitment level.
//   - FAILED: a genuine on-chain error was observed (simulation
//     failure, program error) - this transaction definitely did not
//     succeed.
//   - TIMEOUT: the poll gave up without a definite answer - either the
//     poll window simply elapsed (reason: POLL_WINDOW_ELAPSED, "still
//     unknown, keep watching or reconcile later") or the transaction's
//     blockhash has expired without ever appearing (reason:
//     BLOCKHASH_EXPIRED, "this specific attempt can never land, but
//     that's a fact about the attempt, not a confirmed on-chain
//     rejection").

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_COMMITMENT = "confirmed";

const COMMITMENT_RANK = { processed: 0, confirmed: 1, finalized: 2 };

function defaultSleep(ms){
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @typedef {object} ConfirmationResult
 * @property {"SUCCESS"|"FAILED"|"TIMEOUT"} outcome
 * @property {"ON_CHAIN_ERROR"|"POLL_WINDOW_ELAPSED"|"BLOCKHASH_EXPIRED"|null} reason
 * @property {string} signature
 * @property {number} elapsedMs
 * @property {number|null} slot
 * @property {object|null} err
 */

/**
 * @param {import("./solanaConnectionProvider").SolanaConnectionProvider} connectionProvider
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollIntervalMs]
 * @param {string} [options.commitment]
 * @param {(ms: number) => Promise<void>} [options.sleep] - injected purely so tests never actually wait
 */
function createTransactionConfirmationService(connectionProvider, options = {}){

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const requiredCommitment = options.commitment ?? DEFAULT_COMMITMENT;
    const sleep = options.sleep ?? defaultSleep;

    /**
     * @param {object} params
     * @param {string} params.signature
     * @param {number} [params.lastValidBlockHeight] - persisted by executionService.js at PREPARING time
     * @returns {Promise<ConfirmationResult>}
     */
    async function confirm({ signature, lastValidBlockHeight }){

        const connection = connectionProvider.getConnection();
        const startedAt = Date.now();

        while(true){

            const elapsedMs = Date.now() - startedAt;

            if(elapsedMs >= timeoutMs){
                return { outcome: "TIMEOUT", reason: "POLL_WINDOW_ELAPSED", signature, elapsedMs, slot: null, err: null };
            }

            const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
            const value = status?.value ?? null;

            if(value){

                if(value.err){
                    return { outcome: "FAILED", reason: "ON_CHAIN_ERROR", signature, elapsedMs: Date.now() - startedAt, slot: value.slot ?? null, err: value.err };
                }

                const rank = COMMITMENT_RANK[value.confirmationStatus] ?? -1;
                const requiredRank = COMMITMENT_RANK[requiredCommitment] ?? COMMITMENT_RANK.confirmed;

                if(rank >= requiredRank){
                    return { outcome: "SUCCESS", reason: null, signature, elapsedMs: Date.now() - startedAt, slot: value.slot ?? null, err: null };
                }

            }
            else if(lastValidBlockHeight != null){

                const currentBlockHeight = await connection.getBlockHeight(requiredCommitment);

                if(currentBlockHeight > lastValidBlockHeight){
                    return { outcome: "TIMEOUT", reason: "BLOCKHASH_EXPIRED", signature, elapsedMs: Date.now() - startedAt, slot: null, err: null };
                }

            }

            await sleep(pollIntervalMs);

        }

    }

    return { confirm };

}

module.exports = { createTransactionConfirmationService };
