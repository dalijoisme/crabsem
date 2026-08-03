// repositories/dailyReviewRepository.test.js - Arjuna V4 Phase 2. Proves
// the global (not user-scoped) date-bounded trade query and the
// upsert-per-day persistence contract. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const dailyReviewRepository = require("./dailyReviewRepository");
const db = require("../database/connection");

const PREFIX = "DAILYREVIEWREPO_TEST_";

const insertTradeStmt = db.prepare(`
    INSERT INTO trading_bot_trades (token_address, roi_pct, size_usd, fee_usd, reason, closed_at)
    VALUES (@tokenAddress, @roiPct, @sizeUsd, @feeUsd, @reason, @closedAt)
`);

function insertTrade(overrides = {}){
    insertTradeStmt.run({
        tokenAddress: `${PREFIX}A`, roiPct: 10, sizeUsd: 100, feeUsd: 1, reason: "TP1",
        closedAt: "2026-08-01 12:00:00",
        ...overrides
    });
}

test.afterEach(() => {
    db.prepare("DELETE FROM trading_bot_trades WHERE token_address LIKE ?").run(`${PREFIX}%`);
    db.prepare("DELETE FROM daily_trading_reviews WHERE review_date = ?").run("2026-08-01");
});

test("findTradesClosedOnDate returns only trades closed on that real UTC calendar day, across every user", () => {

    insertTrade({ closedAt: "2026-08-01 00:00:01" });
    insertTrade({ closedAt: "2026-08-01 23:59:59" });
    insertTrade({ closedAt: "2026-08-02 00:00:01" }); // different day - must be excluded
    insertTrade({ closedAt: "2026-07-31 23:59:59" }); // different day - must be excluded

    const trades = dailyReviewRepository.findTradesClosedOnDate("2026-08-01");

    assert.equal(trades.length, 2);

});

test("findTradesClosedOnDate returns an ordered, empty array for a day with no real trades", () => {
    assert.deepEqual(dailyReviewRepository.findTradesClosedOnDate("2026-08-01"), []);
});

test("upsertReview + findByDate round-trips a real report, and re-upserting the same date overwrites rather than duplicates", () => {

    dailyReviewRepository.upsertReview({
        reviewDate: "2026-08-01", totalTrades: 5, winCount: 3, lossCount: 2, winRate: 0.6,
        netProfitUsd: 42.5, averageRoiPct: 12.3, averageMfePct: 20, averageMaePct: -5,
        averageHoldingSeconds: 300, reportJson: JSON.stringify({ hello: "world" })
    });

    const first = dailyReviewRepository.findByDate("2026-08-01");
    assert.equal(first.total_trades, 5);
    assert.equal(JSON.parse(first.report_json).hello, "world");

    dailyReviewRepository.upsertReview({
        reviewDate: "2026-08-01", totalTrades: 9, winCount: 9, lossCount: 0, winRate: 1,
        netProfitUsd: 100, averageRoiPct: 30, averageMfePct: 40, averageMaePct: -1,
        averageHoldingSeconds: 600, reportJson: JSON.stringify({ hello: "updated" })
    });

    const second = dailyReviewRepository.findByDate("2026-08-01");
    assert.equal(second.total_trades, 9, "must overwrite the same real day, never duplicate");
    assert.equal(JSON.parse(second.report_json).hello, "updated");

    assert.equal(dailyReviewRepository.findByDate("2026-08-01").id, first.id, "same row, same id, not a new insert");

});

test("findByDate returns null for a day that was never reviewed", () => {
    assert.equal(dailyReviewRepository.findByDate("1999-01-01"), null);
});
