// services/execution/executorStateMachine.test.js - proves every legal
// transition succeeds, every illegal transition throws instead of
// silently mutating state, and onTransition fires with the right
// (from, to, meta) on every legal move. Pure module, no fakes needed.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createExecutorStateMachine, STATES } = require("./executorStateMachine");

test("starts in IDLE by default and is not terminal", () => {
    const machine = createExecutorStateMachine();
    assert.equal(machine.getState(), STATES.IDLE);
    assert.equal(machine.isTerminal(), false);
});

test("walks the full happy path IDLE -> SUCCESS", () => {
    const machine = createExecutorStateMachine();
    machine.transition(STATES.PREPARING);
    machine.transition(STATES.SIGNING);
    machine.transition(STATES.SUBMITTING);
    machine.transition(STATES.SUBMITTED);
    machine.transition(STATES.CONFIRMING);
    machine.transition(STATES.SUCCESS);
    assert.equal(machine.getState(), STATES.SUCCESS);
    assert.equal(machine.isTerminal(), true);
});

test("CONFIRMING can resolve to FAILED or TIMEOUT, not just SUCCESS", () => {
    const failed = createExecutorStateMachine({ initialState: STATES.CONFIRMING });
    failed.transition(STATES.FAILED);
    assert.equal(failed.getState(), STATES.FAILED);

    const timedOut = createExecutorStateMachine({ initialState: STATES.CONFIRMING });
    timedOut.transition(STATES.TIMEOUT);
    assert.equal(timedOut.getState(), STATES.TIMEOUT);
});

test("PREPARING/SIGNING/SUBMITTING can each fail directly", () => {
    for(const from of [STATES.PREPARING, STATES.SIGNING, STATES.SUBMITTING]){
        const machine = createExecutorStateMachine({ initialState: from });
        machine.transition(STATES.FAILED);
        assert.equal(machine.getState(), STATES.FAILED);
    }
});

test("rejects skipping SUBMITTED - SUBMITTING cannot go straight to CONFIRMING", () => {
    const machine = createExecutorStateMachine({ initialState: STATES.SUBMITTING });
    assert.throws(() => machine.transition(STATES.CONFIRMING), /illegal transition/);
    // state must be unchanged after a rejected transition
    assert.equal(machine.getState(), STATES.SUBMITTING);
});

test("rejects any transition out of a terminal state", () => {
    for(const terminal of [STATES.SUCCESS, STATES.FAILED, STATES.TIMEOUT]){
        const machine = createExecutorStateMachine({ initialState: terminal });
        assert.throws(() => machine.transition(STATES.IDLE), /illegal transition/);
    }
});

test("rejects jumping straight to a non-adjacent state", () => {
    const machine = createExecutorStateMachine();
    assert.throws(() => machine.transition(STATES.SUBMITTED), /illegal transition/);
});

test("onTransition fires with (from, to, meta) on every legal move, never on a rejected one", () => {
    const calls = [];
    const machine = createExecutorStateMachine({
        onTransition: (from, to, meta) => calls.push({ from, to, meta })
    });

    machine.transition(STATES.PREPARING, { blockhash: "abc" });
    assert.throws(() => machine.transition(STATES.SUBMITTING));

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { from: STATES.IDLE, to: STATES.PREPARING, meta: { blockhash: "abc" } });
});

test("two state machines are fully independent", () => {
    const a = createExecutorStateMachine();
    const b = createExecutorStateMachine();
    a.transition(STATES.PREPARING);
    assert.equal(a.getState(), STATES.PREPARING);
    assert.equal(b.getState(), STATES.IDLE);
});
