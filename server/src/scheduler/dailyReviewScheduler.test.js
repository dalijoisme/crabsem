// scheduler/dailyReviewScheduler.test.js - Arjuna V4 Phase 2. Proves the
// once-a-day trigger: generates exactly once for a not-yet-reviewed day,
// is a cheap no-op once that day is already reviewed (idempotent), and
// always targets "yesterday" (the most recently fully-completed real UTC
// day), never today (which is still in progress). Pure wiring test, same
// stub-at-module-level convention scheduler/tradingBotScheduler.test.js
// already uses. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const scheduler = require("./dailyReviewScheduler");
const dailyReviewRepository = require("../repositories/dailyReviewRepository");
const dailyReviewService = require("../services/dailyReviewService");

function stub(obj, method, fn){
    const original = obj[method];
    obj[method] = fn;
    return () => { obj[method] = original; };
}

test("mostRecentCompletedUtcDate returns real yesterday, correctly crossing a month boundary", (t) => {

    // node:test's built-in Date mock (not a bare Date.now reassignment -
    // `new Date()` doesn't consult the overridable static Date.now
    // internally, so only a real mock replaces both) - same technique
    // already proven in scheduler/tradingBotScheduler.test.js's own
    // watchdog test.
    t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 7, 1, 10, 0, 0) }); // 2026-08-01 - yesterday must be 2026-07-31

    try{
        assert.equal(scheduler.mostRecentCompletedUtcDate(), "2026-07-31");
    }
    finally{
        t.mock.timers.reset();
    }

});

test("tick() generates and persists exactly once for a not-yet-reviewed day", () => {

    let generateCallCount = 0;
    const restores = [
        stub(dailyReviewRepository, "findByDate", () => null),
        stub(dailyReviewService, "generateAndPersistReview", (date) => {
            generateCallCount++;
            return { tradingSummary: { totalTrades: 3, winRate: 0.5, netProfitUsd: 10 } };
        })
    ];

    try{
        scheduler.tick();
        assert.equal(generateCallCount, 1);
    }
    finally{
        restores.forEach(r => r());
    }

});

test("tick() is a cheap no-op once the target day is already reviewed - never regenerates it", () => {

    let generateCallCount = 0;
    const restores = [
        stub(dailyReviewRepository, "findByDate", () => ({ review_date: "2026-07-31", total_trades: 5 })),
        stub(dailyReviewService, "generateAndPersistReview", () => { generateCallCount++; return {}; })
    ];

    try{
        scheduler.tick();
        assert.equal(generateCallCount, 0, "must never regenerate a day that findByDate already confirms is reviewed");
    }
    finally{
        restores.forEach(r => r());
    }

});

test("tick() always requests yesterday's date, never today's (still in-progress day)", () => {

    let requestedDate = null;
    const restores = [
        stub(dailyReviewRepository, "findByDate", (date) => { requestedDate = date; return { review_date: date }; })
    ];

    try{
        scheduler.tick();
        assert.equal(requestedDate, scheduler.mostRecentCompletedUtcDate());
    }
    finally{
        restores.forEach(r => r());
    }

});

test("tick() catches a real error from generateAndPersistReview and records it via getTickHealth, without throwing", () => {

    const restores = [
        stub(dailyReviewRepository, "findByDate", () => null),
        stub(dailyReviewService, "generateAndPersistReview", () => { throw new Error("simulated DB failure"); })
    ];

    try{
        assert.doesNotThrow(() => scheduler.tick());
        assert.equal(scheduler.getTickHealth().lastError, "simulated DB failure");
    }
    finally{
        restores.forEach(r => r());
    }

});

test("getTickHealth reflects a real, just-updated lastGeneratedDate after a successful generation", () => {

    const restores = [
        stub(dailyReviewRepository, "findByDate", () => null),
        stub(dailyReviewService, "generateAndPersistReview", () => ({ tradingSummary: { totalTrades: 1, winRate: 1, netProfitUsd: 5 } }))
    ];

    try{
        scheduler.tick();
        const health = scheduler.getTickHealth();
        assert.equal(health.lastGeneratedDate, scheduler.mostRecentCompletedUtcDate());
        assert.ok(health.lastGeneratedAt);
        assert.equal(health.lastError, null);
    }
    finally{
        restores.forEach(r => r());
    }

});
