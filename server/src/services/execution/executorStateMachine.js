// services/execution/executorStateMachine.js - pure state machine, no
// I/O, no dependencies. The only thing this file knows is which
// transitions are legal and which callback to fire when one happens -
// services/execution/executionService.js is the only caller, and it's
// the one that actually does anything (persist, sign, broadcast, poll)
// in response to a transition.
//
// SUBMITTED and TIMEOUT are deliberately their own states, not folded
// into SUBMITTING/FAILED:
//   - SUBMITTED is a crash-safe checkpoint - it exists so tx_hash gets
//     persisted the instant sendRawTransaction returns a signature,
//     BEFORE any confirmation polling starts. Without it, a process
//     crash between broadcast and confirmation leaves no record that a
//     real transaction may already be on-chain.
//   - TIMEOUT means "the confirmation poll gave up - outcome unknown."
//     FAILED means "a genuine on-chain rejection was observed." A
//     Solana transaction can still land after a client stops watching
//     it, so conflating these two would make a future retry (Sprint 2+)
//     rebroadcast a transaction that actually already succeeded.

/**
 * @typedef {"IDLE"|"PREPARING"|"SIGNING"|"SUBMITTING"|"SUBMITTED"|"CONFIRMING"|"SUCCESS"|"FAILED"|"TIMEOUT"} ExecutionState
 */

const STATES = Object.freeze({
    IDLE: "IDLE",
    PREPARING: "PREPARING",
    SIGNING: "SIGNING",
    SUBMITTING: "SUBMITTING",
    SUBMITTED: "SUBMITTED",
    CONFIRMING: "CONFIRMING",
    SUCCESS: "SUCCESS",
    FAILED: "FAILED",
    TIMEOUT: "TIMEOUT"
});

const TERMINAL_STATES = Object.freeze([STATES.SUCCESS, STATES.FAILED, STATES.TIMEOUT]);

/** @type {Record<ExecutionState, ExecutionState[]>} */
const LEGAL_TRANSITIONS = Object.freeze({
    IDLE: [STATES.PREPARING],
    PREPARING: [STATES.SIGNING, STATES.FAILED],
    SIGNING: [STATES.SUBMITTING, STATES.FAILED],
    SUBMITTING: [STATES.SUBMITTED, STATES.FAILED],
    SUBMITTED: [STATES.CONFIRMING],
    CONFIRMING: [STATES.SUCCESS, STATES.FAILED, STATES.TIMEOUT],
    SUCCESS: [],
    FAILED: [],
    TIMEOUT: []
});

/**
 * @callback OnTransition
 * @param {ExecutionState} from
 * @param {ExecutionState} to
 * @param {object} [meta]
 * @returns {void}
 */

/**
 * @param {object} [options]
 * @param {ExecutionState} [options.initialState]
 * @param {OnTransition} [options.onTransition]
 */
function createExecutorStateMachine({ initialState = STATES.IDLE, onTransition } = {}){

    let current = initialState;

    function getState(){
        return current;
    }

    function isTerminal(){
        return TERMINAL_STATES.includes(current);
    }

    /**
     * @param {ExecutionState} to
     * @param {object} [meta] - passed through to onTransition verbatim; this file never inspects it
     */
    function transition(to, meta){

        const allowed = LEGAL_TRANSITIONS[current];

        if(!allowed){
            throw new Error(`executorStateMachine: unknown current state "${current}"`);
        }

        if(!allowed.includes(to)){
            throw new Error(`executorStateMachine: illegal transition ${current} -> ${to} (allowed from ${current}: ${allowed.join(", ") || "none, terminal"})`);
        }

        const from = current;
        current = to;

        if(onTransition) onTransition(from, to, meta);

        return current;

    }

    return { getState, isTerminal, transition };

}

module.exports = { createExecutorStateMachine, STATES, TERMINAL_STATES, LEGAL_TRANSITIONS };
