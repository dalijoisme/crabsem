// repositories/tokenPriceHistoryRepository.test.js - proves
// pruneOlderThan's rewrite from one unbatched DELETE to batched +
// event-loop-yielding (RATE_LIMIT_BANNED incident follow-up,
// 2026-08-06 - same fix, same evidence, as
// predictionHistoryRepository.js's own pruneOlderThan; see that
// function's header for the full incident writeup this closes:
// "validation-scheduler 345 seconds as ONE unbatched DELETE"). The
// critical property under test: only rows past the real age bound are
// ever removed, and a backlog larger than one batch
// (PRUNE_BATCH_SIZE=200) is still fully drained in one call - this is
// a query-shape optimization, not a "prune less" behavior change.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const tokenPriceHistoryRepository = require("./tokenPriceHistoryRepository");
const db = require("../database/connection");

const PREFIX = "TOKENPRICEHIST_TEST_";

test.afterEach(() => {
    db.prepare("DELETE FROM token_price_history WHERE token_address LIKE ?").run(`${PREFIX}%`);
});

test("pruneOlderThan only removes rows past the real age bound", async () => {

    const address = `${PREFIX}A`;
    tokenPriceHistoryRepository.insertMany([{ tokenAddress: address, price: 1, marketCap: 1000, liquidity: 500 }]);

    // maxAgeHours=1000 must never delete a row inserted moments ago.
    await tokenPriceHistoryRepository.pruneOlderThan(1000);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM token_price_history WHERE token_address = ?").get(address).c, 1);

    // Backdate the row directly (deterministic - SQLite's CURRENT_TIMESTAMP
    // 1-second resolution makes a real "insert then immediately prune"
    // boundary flaky) rather than relying on real elapsed wall time.
    db.prepare("UPDATE token_price_history SET recorded_at = datetime('now', '-2 hours') WHERE token_address = ?").run(address);

    const deleted = await tokenPriceHistoryRepository.pruneOlderThan(1);

    assert.ok(deleted >= 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM token_price_history WHERE token_address = ?").get(address).c, 0);

});

test("pruneOlderThan drains a backlog larger than one batch completely, not just the first batch", async () => {

    const address = `${PREFIX}BATCH`;
    const rowCount = 250; // > PRUNE_BATCH_SIZE (200)

    tokenPriceHistoryRepository.insertMany(
        Array.from({ length: rowCount }, (_, i) => ({ tokenAddress: address, price: i, marketCap: 1000, liquidity: 500 }))
    );

    db.prepare("UPDATE token_price_history SET recorded_at = datetime('now', '-2 hours') WHERE token_address = ?").run(address);

    const deleted = await tokenPriceHistoryRepository.pruneOlderThan(1);

    assert.equal(deleted, rowCount, "every eligible row must be pruned in one call, even across multiple batches");

    const remaining = db.prepare("SELECT COUNT(*) c FROM token_price_history WHERE token_address = ?").get(address).c;
    assert.equal(remaining, 0);

});
