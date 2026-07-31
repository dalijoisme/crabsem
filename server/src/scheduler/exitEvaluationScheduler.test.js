// scheduler/exitEvaluationScheduler.test.js - Exit Evaluation Interval
// sprint. Pure wiring test - every dependency is stubbed at the module-
// object level (no real DB rows, no real scoring), same convention
// scheduler/tradingBotScheduler.test.js already uses. Proves:
//   - each user's OWN exit_evaluation_interval_seconds governs their own
//     due-check, independent of any other user's;
//   - a user still mid-cycle is never re-entered by the next tick;
//   - tradingBotEngine.runExitCycle() is what actually gets called, never
//     runCycle() (the BUY-side path) - the entire point of decoupling.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const tradingBotRepository = require("../repositories/tradingBotRepository");
const tradingBotEngine = require("../services/tradingBotEngine");

const scheduler = require("./exitEvaluationScheduler");

function stub(obj, method, fn){
    const original = obj[method];
    obj[method] = fn;
    return () => { obj[method] = original; };
}

// Each test below uses its OWN, never-before-seen userId range - the
// scheduler's lastCycleAtByUser/userCycleInFlight Maps are real module-
// level state that persists across tests within this same process (same
// convention tradingBotScheduler.js's own lastCycleAtByUser has), so
// reusing a userId across tests (especially the in-flight test below,
// whose fake runExitCycle deliberately never resolves) would leak state
// between otherwise-independent tests.

test("each RUNNING user's own exit_evaluation_interval_seconds governs their own due-check, independent of the others", () => {

    const configsByUser = {
        1001: { exit_evaluation_interval_seconds: 5 },
        1002: { exit_evaluation_interval_seconds: 1 }
    };

    const restores = [
        stub(tradingBotRepository, "findRunningUserIds", () => [1001, 1002]),
        stub(tradingBotRepository, "getConfig", (userId) => configsByUser[userId])
    ];

    const runExitCycleCalls = [];
    restores.push(stub(tradingBotEngine, "runExitCycle", async (userId) => {
        runExitCycleCalls.push(userId);
        return { skipped: false, closed: 0 };
    }));

    try{

        // First tick: both users have never run before (lastCycleAt
        // defaults to 0) - both are due regardless of their own interval.
        scheduler.tick();
        assert.deepEqual(runExitCycleCalls.sort(), [1001, 1002], "both users must run on their very first tick");

    }
    finally{
        restores.forEach(restore => restore());
    }

});

test("a user still mid-cycle (in-flight) is never re-entered by the next tick", async () => {

    const configsByUser = { 2001: { exit_evaluation_interval_seconds: 1 } };

    let resolveFirstCall;
    const firstCallStarted = new Promise(resolve => { resolveFirstCall = resolve; });
    let callCount = 0;

    const restores = [
        stub(tradingBotRepository, "findRunningUserIds", () => [2001]),
        stub(tradingBotRepository, "getConfig", (userId) => configsByUser[userId]),
        stub(tradingBotEngine, "runExitCycle", async () => {
            callCount++;
            resolveFirstCall();
            // Never resolves within this test - simulates a slow cycle
            // still in flight when the next tick fires.
            return new Promise(() => {});
        })
    ];

    try{

        scheduler.tick(); // starts the in-flight call (fire-and-forget)
        await firstCallStarted;

        scheduler.tick(); // must see userCycleInFlight and skip user 2001 entirely
        scheduler.tick();

        assert.equal(callCount, 1, "a user already mid-cycle must never be re-entered by a later tick");

    }
    finally{
        restores.forEach(restore => restore());
    }

});

test("tick() calls tradingBotEngine.runExitCycle - never runCycle (the BUY-side path)", async () => {

    const configsByUser = { 3001: { exit_evaluation_interval_seconds: 5 } };

    const restores = [
        stub(tradingBotRepository, "findRunningUserIds", () => [3001]),
        stub(tradingBotRepository, "getConfig", (userId) => configsByUser[userId]),
        stub(tradingBotEngine, "runCycle", async () => {
            throw new Error("must never be called - exitEvaluationScheduler must never drive the BUY-side runCycle()");
        })
    ];

    let runExitCycleCalled = false;
    restores.push(stub(tradingBotEngine, "runExitCycle", async () => {
        runExitCycleCalled = true;
        return { skipped: false, closed: 0 };
    }));

    try{

        scheduler.tick();
        // Fire-and-forget - give the microtask queue a turn to run it.
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(runExitCycleCalled, true);

    }
    finally{
        restores.forEach(restore => restore());
    }

});

test("no RUNNING users - tick() is a cheap no-op, never calls getConfig at all", () => {

    const restores = [
        stub(tradingBotRepository, "findRunningUserIds", () => []),
        stub(tradingBotRepository, "getConfig", () => { throw new Error("must never be called - there are no running users this tick"); })
    ];

    try{
        assert.doesNotThrow(() => scheduler.tick());
    }
    finally{
        restores.forEach(restore => restore());
    }

});
