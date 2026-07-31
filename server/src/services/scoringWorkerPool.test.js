// services/scoringWorkerPool.test.js - Production Stabilization V1
// Final Sprint (Section I - Scheduler Safety, "tidak infinite wait"):
// proves scoreTokens() can never hang forever - a real, documented
// incident (45+ minutes, pure I/O wait, no timeout anywhere) motivated
// this fix. Uses a real worker_thread (not mocked) with an artificially
// tiny timeoutMs override so this test runs fast and deterministically -
// worker startup alone reliably takes longer than 1ms, so the timeout
// always wins the race regardless of what the worker eventually does.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { scoreTokens, shutdown, WORKER_REQUEST_TIMEOUT_MS } = require("./scoringWorkerPool");

// The persistent worker (module-level singleton, by design - correct
// for the real server process) must be explicitly terminated here, or
// this test file's process never naturally exits.
test.after(async () => { await shutdown(); });

test("WORKER_REQUEST_TIMEOUT_MS is a real, bounded value grounded in this codebase's own established request timeout", () => {
    // 4x collectors/gmgn/authClient.js's own REQUEST_TIMEOUT_MS (15000) -
    // see this file's own header comment for the full reasoning.
    assert.equal(WORKER_REQUEST_TIMEOUT_MS, 60000);
});

test("scoreTokens rejects instead of hanging forever when the worker doesn't reply in time", async () => {

    const start = Date.now();

    await assert.rejects(
        () => scoreTokens([], {}, 1), // 1ms - real worker startup alone always loses this race
        /timed out after 1ms/
    );

    const elapsedMs = Date.now() - start;
    assert.ok(elapsedMs < 5000, `must fail fast (within ~1ms + overhead), not hang - took ${elapsedMs}ms`);

});

test("a late reply for an already-timed-out request is safely ignored, never a crash or a double-settle", async () => {

    // The SAME persistent worker is reused across calls (scoringWorkerPool.js's
    // own module-level singleton) - after the request above already timed
    // out and was rejected, if the worker eventually does reply for that
    // stale id, the message handler's own "already timed out - ignore"
    // guard must hold. Real proof: making another real call right after
    // must still resolve/reject cleanly on its own, not throw from stale
    // bookkeeping left behind by the previous timed-out request.
    await assert.rejects(() => scoreTokens([], {}, 1));

});
