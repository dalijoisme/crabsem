// collectors/gmgn/gmgnTrafficAccounting.test.js - RATE_LIMIT_BANNED
// investigation, round 2. Proves the actual measurement math this
// investigation depends on: origin attribution survives real async call
// chains (including concurrent ones), an untagged call is a real,
// visible "unattributed" row rather than silently miscounted, and the
// aggregation (calls/min, %total) is numerically correct and sums to
// 100%. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const accounting = require("./gmgnTrafficAccounting");

test.beforeEach(() => { accounting._resetForTest(); });
test.afterEach(() => { accounting._resetForTest(); });

test("withOrigin/getCurrentOrigin: origin is visible inside the call, unattributed outside it", async () => {

    assert.equal(accounting.getCurrentOrigin(), "unattributed");

    await accounting.withOrigin("test-origin-a", async () => {
        assert.equal(accounting.getCurrentOrigin(), "test-origin-a");
        await new Promise(resolve => setTimeout(resolve, 0)); // survives a real async tick
        assert.equal(accounting.getCurrentOrigin(), "test-origin-a");
    });

    assert.equal(accounting.getCurrentOrigin(), "unattributed");

});

test("withOrigin: concurrent call chains never leak origin into each other", async () => {

    const seenInA = [];
    const seenInB = [];

    await Promise.all([
        accounting.withOrigin("chain-a", async () => {
            await new Promise(resolve => setTimeout(resolve, 5));
            seenInA.push(accounting.getCurrentOrigin());
        }),
        accounting.withOrigin("chain-b", async () => {
            await new Promise(resolve => setTimeout(resolve, 1));
            seenInB.push(accounting.getCurrentOrigin());
        })
    ]);

    assert.deepEqual(seenInA, ["chain-a"]);
    assert.deepEqual(seenInB, ["chain-b"]);

});

test("record() inside withOrigin attributes to that origin; outside it falls back to a visible 'unattributed' row with a stack sample", () => {

    accounting.withOrigin("scheduler:trending", () => {
        accounting.record({ method: "GET", subPath: "/v1/market/rank" });
    });

    accounting.record({ method: "GET", subPath: "/v1/some/untagged/endpoint" });

    const { rows } = accounting.getTrafficAccounting();

    const tagged = rows.find(r => r.origin === "scheduler:trending");
    assert.ok(tagged, "the tagged call must show up under its real origin");
    assert.equal(tagged.callCount, 1);

    const untagged = rows.find(r => r.origin === "unattributed");
    assert.ok(untagged, "a call made with no origin context must be a real, visible row - never silently dropped or misattributed");
    assert.ok(untagged.stackSample, "an unattributed call must carry a stack sample so its real source can be found");

});

test("getTrafficAccounting: calls/min and %total are numerically correct and percentages sum to 100", async (t) => {

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

    try{

        // 3 calls to origin A, 1 call to origin B, spread over exactly 60s -
        // real, known math: A should be 75%, B should be 25%.
        accounting.withOrigin("origin-a", () => accounting.record({ method: "GET", subPath: "/v1/endpoint-a" }));
        t.mock.timers.tick(20000);
        accounting.withOrigin("origin-a", () => accounting.record({ method: "GET", subPath: "/v1/endpoint-a" }));
        t.mock.timers.tick(20000);
        accounting.withOrigin("origin-a", () => accounting.record({ method: "GET", subPath: "/v1/endpoint-a" }));
        t.mock.timers.tick(20000);
        accounting.withOrigin("origin-b", () => accounting.record({ method: "GET", subPath: "/v1/endpoint-b" }));

        const result = accounting.getTrafficAccounting();

        assert.equal(result.totalCalls, 4);
        assert.equal(result.elapsedMs, 60000, "elapsed must be the REAL observed span between the oldest record and now, not the nominal window");

        const rowA = result.rows.find(r => r.origin === "origin-a");
        const rowB = result.rows.find(r => r.origin === "origin-b");

        assert.equal(rowA.callCount, 3);
        assert.equal(rowB.callCount, 1);
        assert.equal(rowA.percentageOfTotal, 75);
        assert.equal(rowB.percentageOfTotal, 25);

        // 3 calls in 60000ms of real elapsed time = 3 calls/min exactly.
        assert.equal(rowA.callsPerMinute, 3);
        assert.equal(rowB.callsPerMinute, 1);

        const totalPct = result.rows.reduce((s, r) => s + r.percentageOfTotal, 0);
        assert.equal(totalPct, 100, "percentages across every row must sum to exactly 100%");

    }
    finally{
        t.mock.timers.reset();
    }

});

test("getTrafficAccounting: rows are sorted by call count, descending (biggest contributor first)", () => {

    accounting.withOrigin("small", () => accounting.record({ method: "GET", subPath: "/v1/small" }));
    accounting.withOrigin("big", () => {
        accounting.record({ method: "GET", subPath: "/v1/big" });
        accounting.record({ method: "GET", subPath: "/v1/big" });
        accounting.record({ method: "GET", subPath: "/v1/big" });
    });

    const { rows } = accounting.getTrafficAccounting();

    assert.equal(rows[0].origin, "big", "the endpoint/origin pair with the most real calls must be listed first");
    assert.equal(rows[0].callCount, 3);

});

test("getTrafficAccounting: a windowMs shorter than a record's age excludes it - windowing is real, not cosmetic", async (t) => {

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

    try{

        accounting.withOrigin("old-origin", () => accounting.record({ method: "GET", subPath: "/v1/old" }));
        t.mock.timers.tick(5 * 60 * 1000); // 5 minutes later
        accounting.withOrigin("recent-origin", () => accounting.record({ method: "GET", subPath: "/v1/recent" }));

        const last1Min = accounting.getTrafficAccounting(60000);
        assert.equal(last1Min.totalCalls, 1, "a 1-minute window must exclude the 5-minute-old record");
        assert.equal(last1Min.rows[0].origin, "recent-origin");

        const last10Min = accounting.getTrafficAccounting(10 * 60 * 1000);
        assert.equal(last10Min.totalCalls, 2, "a 10-minute window must include both records");

    }
    finally{
        t.mock.timers.reset();
    }

});

test("getTrafficAccounting: an empty window returns an honest zero, never a fabricated row", () => {

    const result = accounting.getTrafficAccounting();
    assert.equal(result.totalCalls, 0);
    assert.deepEqual(result.rows, []);

});

test("formatAccountingTable: renders the requested columns and a TOTAL line", () => {

    accounting.withOrigin("scheduler:trending", () => accounting.record({ method: "GET", subPath: "/v1/market/rank" }));

    const table = accounting.formatAccountingTable(accounting.getTrafficAccounting());

    assert.ok(table.includes("Endpoint"));
    assert.ok(table.includes("Calls/min"));
    assert.ok(table.includes("Call Chain"));
    assert.ok(table.includes("Source File"));
    assert.ok(table.includes("Wajib"));
    assert.ok(table.includes("Cache?"));
    assert.ok(table.includes("Coalesce?"));
    assert.ok(table.includes("scheduler:trending"));
    assert.ok(table.includes("TOTAL:"));

});

test("ORIGIN_METADATA has an entry for every real call site tagged in production code, plus the unattributed fallback", () => {

    const expectedOrigins = [
        "scheduler:trending", "scheduler:trenches", "scheduler:hot_searches",
        "scheduler:kol_activity", "scheduler:smart_money_activity", "scheduler:gas_price", "scheduler:launchpad_stats",
        "held-position-refresh-scheduler", "held-position-fallback-direct-fetch",
        "usd-to-sol-price-probe", "execution:buy-quote", "execution:sell-quote", "execution:submit-swap",
        "unattributed"
    ];

    for(const origin of expectedOrigins){
        assert.ok(accounting.ORIGIN_METADATA[origin], `missing static provenance metadata for origin "${origin}"`);
    }

});
