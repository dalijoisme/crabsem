// scripts/validation/task4_stateMachine.js - Sprint 1.5, Task 4:
// exhaustive state transition validation. executorStateMachine.js is
// pure (no I/O, no DB, no RPC) - this script tries EVERY possible
// (from, to) pair across all 9 states (81 pairs) and records whether
// each one was allowed or rejected, then compares that against the
// state machine's own declared LEGAL_TRANSITIONS table. A pass means
// the two agree in all 81 cases: every legal transition succeeds,
// every illegal transition throws and leaves the state unchanged.
//
// No isolated DB needed - this file never requires testHarness.js.
//
// Usage: node src/scripts/validation/task4_stateMachine.js

const { createExecutorStateMachine, STATES, LEGAL_TRANSITIONS } = require("../../services/execution/executorStateMachine");

const ALL_STATES = Object.values(STATES);

function main(){

    console.log("=== Sprint 1.5 / Task 4: State Machine Transition Validation ===");
    console.log(`States: ${ALL_STATES.join(", ")}`);
    console.log(`Total pairs to test: ${ALL_STATES.length * ALL_STATES.length}`);

    const matrix = [];
    let legalCount = 0;
    let illegalCount = 0;
    let mismatches = [];

    for(const from of ALL_STATES){

        const expectedLegalTargets = new Set(LEGAL_TRANSITIONS[from] || []);

        for(const to of ALL_STATES){

            const machine = createExecutorStateMachine({ initialState: from });
            let allowed;
            let stateAfter;
            let threw = false;

            try{
                machine.transition(to);
                allowed = true;
                stateAfter = machine.getState();
            }
            catch(err){
                allowed = false;
                threw = true;
                stateAfter = machine.getState(); // must still equal `from`
            }

            const shouldBeLegal = expectedLegalTargets.has(to);

            if(allowed) legalCount++; else illegalCount++;

            // Two independent correctness checks per pair:
            //  1. allowed must match the declared LEGAL_TRANSITIONS table
            //  2. a rejected transition must leave state unchanged (from === stateAfter)
            const tableMatches = allowed === shouldBeLegal;
            const stateUnchangedOnReject = allowed || stateAfter === from;

            if(!tableMatches || !stateUnchangedOnReject){
                mismatches.push({ from, to, allowed, shouldBeLegal, stateAfter, threw });
            }

            matrix.push({ from, to, allowed, shouldBeLegal, correct: tableMatches && stateUnchangedOnReject });

        }

    }

    console.log(`Legal transitions attempted: ${legalCount}`);
    console.log(`Illegal transitions attempted: ${illegalCount}`);
    console.log(`Mismatches (state machine disagreeing with its own declared table, or leaking state on a rejected transition): ${mismatches.length}`);

    if(mismatches.length){
        console.error("MISMATCHES:", JSON.stringify(mismatches, null, 2));
    }

    // Coverage: every state must appear at least once as both a `from`
    // and a `to` somewhere in the legal graph, OR be justified as
    // terminal/entry-only - reported for visibility, not treated as a
    // failure on its own.
    const reachableAsTarget = new Set();
    for(const from of ALL_STATES) for(const to of (LEGAL_TRANSITIONS[from] || [])) reachableAsTarget.add(to);
    const unreachableStates = ALL_STATES.filter(s => s !== STATES.IDLE && !reachableAsTarget.has(s));

    const summary = {
        task: 4,
        totalPairsTested: matrix.length,
        legalTransitionsAttempted: legalCount,
        illegalTransitionsAttempted: illegalCount,
        mismatchCount: mismatches.length,
        mismatches,
        unreachableStates, // states no legal transition ever leads to, besides IDLE (the only valid entry point)
        allStates: ALL_STATES,
        legalTransitionTable: LEGAL_TRANSITIONS,
        pass: mismatches.length === 0 && unreachableStates.length === 0
    };

    console.log("===RESULT_JSON===");
    console.log(JSON.stringify(summary, null, 2));

    process.exitCode = summary.pass ? 0 : 1;

}

main();
