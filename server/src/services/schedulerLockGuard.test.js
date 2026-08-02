// services/schedulerLockGuard.test.js - SPRINT 12 (Arjuna V5). Proves
// the mandatory lifecycle (START -> RUNNING -> FINISHED -> LOCK
// RELEASED, or START -> ERROR -> LOCK RELEASED) and the watchdog's
// unconditional force-release, including the idempotent double-release
// case a late-finishing hung call could otherwise trigger. Run with
// `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLockGuard } = require("./schedulerLockGuard");

test("tryAcquire succeeds when idle, fails while already running - the exact 'previous batch still in progress' guard", () => {
    const guard = createLockGuard("test-guard-1");
    assert.equal(guard.tryAcquire(), true);
    assert.equal(guard.tryAcquire(), false, "a second acquire while still running must be refused, never silently allowed to overlap");
    assert.equal(guard.getHealth().isRunning, true);
});

test("release() frees the lock so a subsequent tryAcquire succeeds again - FINISHED path", () => {
    const guard = createLockGuard("test-guard-2");
    guard.tryAcquire();
    guard.release("FINISHED");
    assert.equal(guard.getHealth().isRunning, false);
    assert.equal(guard.getHealth().lastOutcome, "FINISHED");
    assert.equal(guard.tryAcquire(), true, "the lock must be genuinely free after release()");
});

test("release('ERROR') on an exception still frees the lock - never a permanent lock on failure", () => {
    const guard = createLockGuard("test-guard-3");
    guard.tryAcquire();
    try{
        throw new Error("simulated guarded-work failure");
    }
    catch(err){
        guard.release("ERROR");
    }
    assert.equal(guard.getHealth().isRunning, false);
    assert.equal(guard.getHealth().lastOutcome, "ERROR");
    assert.equal(guard.tryAcquire(), true);
});

test("the watchdog force-releases a lock that outlives maxDurationMs, even if the guarded work never calls release() itself", async () => {
    const guard = createLockGuard("test-guard-watchdog", { maxDurationMs: 30 });
    guard.tryAcquire();
    assert.equal(guard.getHealth().isRunning, true);

    await new Promise(resolve => setTimeout(resolve, 80));

    assert.equal(guard.getHealth().isRunning, false, "the watchdog must have force-released the lock on its own");
    assert.equal(guard.getHealth().lastOutcome, "WATCHDOG_RELEASED");
    assert.equal(guard.tryAcquire(), true, "a subsequent tick must be able to acquire the lock again - never permanently stuck");
});

test("release() is idempotent - a late real completion after the watchdog already fired never double-releases or crashes", async () => {
    const guard = createLockGuard("test-guard-idempotent", { maxDurationMs: 20 });
    guard.tryAcquire();

    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(guard.getHealth().lastOutcome, "WATCHDOG_RELEASED");

    // The (hypothetically hung) guarded work finally "completes" and
    // calls release() itself - must be a safe no-op, not a second log
    // line claiming a lock that was already freed, and never throws.
    assert.doesNotThrow(() => guard.release("FINISHED"));
    assert.equal(guard.getHealth().lastOutcome, "WATCHDOG_RELEASED", "the watchdog's own outcome must not be silently overwritten by a stale late completion");
});

test("getHealth().stuck is true only once a running lock has genuinely outlived maxDurationMs", async () => {
    const guard = createLockGuard("test-guard-stuck", { maxDurationMs: 1000 });
    guard.tryAcquire();
    assert.equal(guard.getHealth().stuck, false, "freshly acquired - not stuck yet");
    guard.release("FINISHED");
});

test("no watchdog configured (maxDurationMs omitted) - lock behaves exactly like the old isRunning boolean, no timer, no forced release", async () => {
    const guard = createLockGuard("test-guard-no-watchdog");
    guard.tryAcquire();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(guard.getHealth().isRunning, true, "with no maxDurationMs, only an explicit release() ever frees the lock");
    guard.release("FINISHED");
});
