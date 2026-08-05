// scripts/regressionCompare/compare.test.js - proves the comparator's
// own math (QPS, burst, concurrency, first-difference detection) is
// correct against known, hand-computed inputs - the numbers this tool
// reports must be trustworthy on their own, independent of whatever a
// real runHead.js/runBaseline.js run happens to produce. Run with
// `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeMetrics, findFirstDifference } = require("./compare");

function record({ origin, endpoint, start, finish }){
    return { origin, endpoint, request_start: start, request_finish: finish, status: 200, candidate: null };
}

test("computeMetrics: empty input is an honest zero, never fabricated", () => {
    const m = computeMetrics([]);
    assert.equal(m.totalRequests, 0);
    assert.equal(m.qps, 0);
    assert.equal(m.maxConcurrent, 0);
});

test("computeMetrics: totalRequests and perEndpoint counts are exact", () => {

    const records = [
        record({ origin: "a", endpoint: "GET /x", start: 0, finish: 10 }),
        record({ origin: "a", endpoint: "GET /x", start: 10, finish: 20 }),
        record({ origin: "b", endpoint: "GET /y", start: 20, finish: 30 })
    ];

    const m = computeMetrics(records);
    assert.equal(m.totalRequests, 3);
    assert.deepEqual(m.perEndpoint, { "GET /x": 2, "GET /y": 1 });

});

test("computeMetrics: maxConcurrent correctly detects two real overlapping requests", () => {

    // A: [0,100], B: [50,150] - overlap during [50,100] = 2 concurrent.
    const records = [
        record({ origin: "a", endpoint: "GET /x", start: 0, finish: 100 }),
        record({ origin: "b", endpoint: "GET /y", start: 50, finish: 150 })
    ];

    const m = computeMetrics(records);
    assert.equal(m.maxConcurrent, 2);

});

test("computeMetrics: maxConcurrent is 1 for genuinely sequential (non-overlapping) requests", () => {

    const records = [
        record({ origin: "a", endpoint: "GET /x", start: 0, finish: 50 }),
        record({ origin: "a", endpoint: "GET /x", start: 50, finish: 100 }),
        record({ origin: "a", endpoint: "GET /x", start: 100, finish: 150 })
    ];

    const m = computeMetrics(records);
    assert.equal(m.maxConcurrent, 1, "back-to-back, non-overlapping requests must never be reported as concurrent");

});

test("computeMetrics: maxBurstIn1s counts real requests within a real 1000ms window, excludes ones outside it", () => {

    const records = [
        record({ origin: "a", endpoint: "GET /x", start: 0, finish: 5 }),
        record({ origin: "a", endpoint: "GET /x", start: 100, finish: 105 }),
        record({ origin: "a", endpoint: "GET /x", start: 900, finish: 905 }),
        // Outside the first three's 1000ms window (starts at 0):
        record({ origin: "a", endpoint: "GET /x", start: 2000, finish: 2005 })
    ];

    const m = computeMetrics(records);
    assert.equal(m.maxBurstIn1s, 3, "the first 3 requests (0ms, 100ms, 900ms) fall inside one real 1000ms window; the 4th (2000ms) does not");
    assert.ok(m.tightestBurst);
    assert.equal(m.tightestBurst.count, 3);
    assert.equal(m.tightestBurst.spanMs, 900);

});

test("computeMetrics: qps is computed from the REAL observed span (last finish - first start), not a nominal window", () => {

    // 5 requests at t=0,250,500,750,1000ms, each instantaneous (finish===start) -
    // real span = last finish (1000) - first start (0) = 1000ms = 1s -> exactly 5 req/s.
    const records = [0, 250, 500, 750, 1000].map(t => record({ origin: "a", endpoint: "GET /x", start: t, finish: t }));

    const m = computeMetrics(records);
    assert.equal(m.totalDurationMs, 1000);
    assert.equal(m.qps, 5);

});

test("findFirstDifference: identical (origin, endpoint) sequences report identical:true", () => {

    const a = [record({ origin: "x", endpoint: "GET /a", start: 0, finish: 1 }), record({ origin: "y", endpoint: "GET /b", start: 1, finish: 2 })];
    const b = [record({ origin: "x", endpoint: "GET /a", start: 0, finish: 1 }), record({ origin: "y", endpoint: "GET /b", start: 1, finish: 2 })];

    const result = findFirstDifference(a, b);
    assert.equal(result.identical, true);

});

test("findFirstDifference: a different endpoint at the same position is reported at the real index it occurs", () => {

    const a = [record({ origin: "x", endpoint: "GET /a", start: 0, finish: 1 })];
    const b = [record({ origin: "x", endpoint: "GET /DIFFERENT", start: 0, finish: 1 })];

    const result = findFirstDifference(a, b);
    assert.equal(result.identical, false);
    assert.equal(result.index, 0);
    assert.ok(result.reason.includes("GET /a"));
    assert.ok(result.reason.includes("GET /DIFFERENT"));

});

test("findFirstDifference: identical prefix, then HEAD has extra trailing requests - reported as an addition, not a mismatch", () => {

    const a = [record({ origin: "x", endpoint: "GET /a", start: 0, finish: 1 })];
    const b = [
        record({ origin: "x", endpoint: "GET /a", start: 0, finish: 1 }),
        record({ origin: "y", endpoint: "GET /extra", start: 1, finish: 2 })
    ];

    const result = findFirstDifference(a, b);
    assert.equal(result.identical, false);
    assert.equal(result.index, 1);
    assert.ok(result.reason.includes("TAMBAHAN"));
    assert.ok(result.reason.includes("GET /extra"));

});

test("findFirstDifference: identical prefix, then Arjuna has extra trailing requests HEAD lacks - reported the other way", () => {

    const a = [
        record({ origin: "x", endpoint: "GET /a", start: 0, finish: 1 }),
        record({ origin: "y", endpoint: "GET /only-in-arjuna", start: 1, finish: 2 })
    ];
    const b = [record({ origin: "x", endpoint: "GET /a", start: 0, finish: 1 })];

    const result = findFirstDifference(a, b);
    assert.equal(result.identical, false);
    assert.ok(result.reason.includes("LEBIH BANYAK"));
    assert.ok(result.reason.includes("GET /only-in-arjuna"));

});
