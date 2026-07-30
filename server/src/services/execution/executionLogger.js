// services/execution/executionLogger.js - thin persistence wrapper
// around repositories/executionRepository.js's insertLog(). Does NOT
// measure anything itself (no timers, no RPC endpoint lookups) -
// executionService.js measures latency/endpoint/confirmation time and
// hands this module a plain object to persist. Single responsibility:
// write what you're told, into the right log_type bucket.

/**
 * @param {ReturnType<import("../../repositories/executionRepository").forUser>} repository
 */
function createExecutionLogger(repository){

    /**
     * @param {number} executionId
     * @param {import("./executorStateMachine").ExecutionState} from
     * @param {import("./executorStateMachine").ExecutionState} to
     * @param {object} [meta]
     */
    function logTransition(executionId, from, to, meta = {}){
        repository.insertLog(executionId, {
            logType: "TRANSITION",
            fromStatus: from,
            toStatus: to,
            message: `${from} -> ${to}`,
            rpcEndpoint: meta.rpcEndpoint ?? null,
            latencyMs: meta.latencyMs ?? null,
            meta
        });
    }

    /**
     * @param {number} executionId
     * @param {string} message
     * @param {object} [meta]
     */
    function logError(executionId, message, meta = {}){
        repository.insertLog(executionId, {
            logType: "ERROR",
            message,
            rpcEndpoint: meta.rpcEndpoint ?? null,
            latencyMs: meta.latencyMs ?? null,
            meta
        });
    }

    /**
     * @param {number} executionId
     * @param {object} params
     * @param {string} [params.message]
     * @param {string} [params.rpcEndpoint]
     * @param {number} [params.latencyMs]
     * @param {object} [params.meta]
     */
    function logRpc(executionId, { message, rpcEndpoint, latencyMs, meta } = {}){
        repository.insertLog(executionId, {
            logType: "RPC",
            message: message ?? null,
            rpcEndpoint: rpcEndpoint ?? null,
            latencyMs: latencyMs ?? null,
            meta
        });
    }

    return { logTransition, logError, logRpc };

}

module.exports = { createExecutionLogger };
