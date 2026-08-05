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

test("record() stores the real HTTP status verbatim; a call with no status falls back to an honest 'UNKNOWN', never fabricated", () => {

    accounting.withOrigin("origin-a", () => accounting.record({ method: "GET", subPath: "/v1/a", status: 200 }));
    accounting.withOrigin("origin-a", () => accounting.record({ method: "GET", subPath: "/v1/a", status: 429 }));
    accounting.withOrigin("origin-a", () => accounting.record({ method: "GET", subPath: "/v1/a" })); // no status at all

    const { rows } = accounting.getTrafficHistory();

    const statuses = rows.map(r => r.httpStatus).sort();
    assert.deepEqual(statuses, ["200", "429", "UNKNOWN"].sort(), "200, 429, and a real UNKNOWN fallback must each be their own distinct row - never merged or guessed");

});

test("getTrafficHistory: real records in different real minutes land in different buckets, aligned to the wall-clock minute", async (t) => {

    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-05T10:15:30.000Z") });

    try{

        accounting.withOrigin("origin-a", () => accounting.record({ method: "GET", subPath: "/v1/a", status: 200 }));

        t.mock.timers.tick(60000); // now 10:16:30

        accounting.withOrigin("origin-a", () => accounting.record({ method: "GET", subPath: "/v1/a", status: 200 }));

        const { rows, minuteCount } = accounting.getTrafficHistory();

        assert.equal(minuteCount, 2, "two records a real minute apart must land in two distinct minute buckets");
        assert.deepEqual(rows.map(r => r.minute).sort(), ["2026-08-05T10:15:00.000Z", "2026-08-05T10:16:00.000Z"], "each bucket must be labeled by its real wall-clock minute start, not an offset from process start");

    }
    finally{
        t.mock.timers.reset();
    }

});

test("getTrafficHistory: percentage is computed WITHIN each minute (rows for the same minute sum to 100%), not across the whole window", async (t) => {

    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-05T10:15:00.000Z") });

    try{

        // Minute 1: 3 calls origin-a, 1 call origin-b (75%/25%)
        accounting.withOrigin("origin-a", () => {
            accounting.record({ method: "GET", subPath: "/v1/a", status: 200 });
            accounting.record({ method: "GET", subPath: "/v1/a", status: 200 });
            accounting.record({ method: "GET", subPath: "/v1/a", status: 200 });
        });
        accounting.withOrigin("origin-b", () => accounting.record({ method: "GET", subPath: "/v1/b", status: 200 }));

        t.mock.timers.tick(60000); // minute 2

        // Minute 2: 1 call origin-a only (100%)
        accounting.withOrigin("origin-a", () => accounting.record({ method: "GET", subPath: "/v1/a", status: 200 }));

        const { rows } = accounting.getTrafficHistory();

        const minute1Rows = rows.filter(r => r.minute === "2026-08-05T10:15:00.000Z");
        const minute2Rows = rows.filter(r => r.minute === "2026-08-05T10:16:00.000Z");

        const minute1TotalPct = minute1Rows.reduce((s, r) => s + r.percentage, 0);
        const minute2TotalPct = minute2Rows.reduce((s, r) => s + r.percentage, 0);

        assert.equal(minute1TotalPct, 100, "percentages within minute 1 alone must sum to 100%");
        assert.equal(minute2TotalPct, 100, "percentages within minute 2 alone must sum to 100%, independent of minute 1's own totals");

        assert.equal(minute1Rows.find(r => r.origin === "origin-a").percentage, 75);
        assert.equal(minute1Rows.find(r => r.origin === "origin-b").percentage, 25);
        assert.equal(minute2Rows.find(r => r.origin === "origin-a").percentage, 100);

    }
    finally{
        t.mock.timers.reset();
    }

});

test("getTrafficHistory: each row includes callChain/sourceFile metadata and a real sampleRequest, preferring a non-200 sample over a 200", () => {

    accounting.withOrigin("held-position-fallback-direct-fetch", () => {
        accounting.record({ method: "GET", subPath: "/v1/token/pool_info", status: 200 });
        accounting.record({ method: "GET", subPath: "/v1/token/pool_info", status: 429 });
    });

    const { rows } = accounting.getTrafficHistory();
    const row = rows.find(r => r.origin === "held-position-fallback-direct-fetch" && r.httpStatus === "429");

    assert.ok(row, "the 429 must be its own visible row, not folded into the 200 row");
    assert.equal(row.callChain, accounting.ORIGIN_METADATA["held-position-fallback-direct-fetch"].callChain);
    assert.ok(row.sampleRequest, "a real sample request must be attached");
    assert.equal(row.sampleRequest.status, 429);

});

test("getTrafficHistory: an empty window returns zero rows, never a fabricated minute", () => {

    const result = accounting.getTrafficHistory();
    assert.equal(result.minuteCount, 0);
    assert.equal(result.totalCalls, 0);
    assert.deepEqual(result.rows, []);

});

test("getTrafficHistory: respects a custom bucketMs/windowMs override", async (t) => {

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

    try{

        accounting.withOrigin("origin-a", () => accounting.record({ method: "GET", subPath: "/v1/a", status: 200 }));
        t.mock.timers.tick(20 * 60 * 1000); // 20 minutes later - outside a 10-minute window

        const shortWindow = accounting.getTrafficHistory({ windowMs: 10 * 60 * 1000 });
        assert.equal(shortWindow.totalCalls, 0, "a record older than the requested windowMs must be excluded");

        const fullWindow = accounting.getTrafficHistory({ windowMs: 30 * 60 * 1000 });
        assert.equal(fullWindow.totalCalls, 1, "the same record must still be included in a window wide enough to cover it");

    }
    finally{
        t.mock.timers.reset();
    }

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

// RATE_LIMIT_BANNED investigation, round 4: candidateInfo extraction and
// the millisecond-precision burst timeline.

test("record() extracts candidateInfo (address) from a real pool_info-shaped URL", () => {

    accounting.withOrigin("held-position-refresh-scheduler", () => accounting.record({
        method: "GET", subPath: "/v1/token/pool_info", status: 200,
        url: "https://openapi.gmgn.ai/v1/token/pool_info?chain=sol&address=TokenABC111&timestamp=123&client_id=xyz"
    }));

    const { rows } = accounting.getTrafficHistory();
    assert.deepEqual(rows[0].sampleRequest.candidateInfo, { address: "TokenABC111" });

});

test("record() extracts candidateInfo (input_token/output_token) from a real quote-shaped URL", () => {

    accounting.withOrigin("execution:buy-quote", () => accounting.record({
        method: "GET", subPath: "/v1/trade/quote", status: 200,
        url: "https://openapi.gmgn.ai/v1/trade/quote?chain=sol&input_token=So11111111111111111111111111111111111111112&output_token=TokenXYZ222&slippage=5"
    }));

    const { rows } = accounting.getTrafficHistory();
    assert.deepEqual(rows[0].sampleRequest.candidateInfo, {
        input_token: "So11111111111111111111111111111111111111112",
        output_token: "TokenXYZ222"
    });

});

test("record() with a URL carrying no candidate-identifying params (e.g. gas_price) stores candidateInfo: null - never fabricated", () => {

    accounting.withOrigin("scheduler:gas_price", () => accounting.record({
        method: "GET", subPath: "/v1/trade/gas_price", status: 200,
        url: "https://openapi.gmgn.ai/v1/trade/gas_price?chain=sol&timestamp=123&client_id=xyz"
    }));

    const { rows } = accounting.getTrafficHistory();
    assert.equal(rows[0].sampleRequest.candidateInfo, null);

});

test("record() with no url at all (backward compatible) never throws, candidateInfo: null", () => {

    assert.doesNotThrow(() => {
        accounting.withOrigin("scheduler:gas_price", () => accounting.record({ method: "GET", subPath: "/v1/trade/gas_price", status: 200 }));
    });

    const { rows } = accounting.getTrafficHistory();
    assert.equal(rows[0].sampleRequest.candidateInfo, null);

});

test("record() with a malformed url never throws, candidateInfo: null", () => {

    assert.doesNotThrow(() => {
        accounting.withOrigin("scheduler:gas_price", () => accounting.record({ method: "GET", subPath: "/v1/trade/gas_price", status: 200, url: "not a real url" }));
    });

});

test("getTimelineBeforeFirstFailure: found:false (never a fabricated timeline) when no failure status exists in the window", () => {

    accounting.withOrigin("scheduler:trending", () => accounting.record({ method: "GET", subPath: "/v1/market/rank", status: 200 }));

    const timeline = accounting.getTimelineBeforeFirstFailure();
    assert.equal(timeline.found, false);
    assert.ok(timeline.message);

});

test("getTimelineBeforeFirstFailure: returns real ms-precision rows for exactly the contextMs window before the FIRST 429, sorted oldest-first, with real gapMsFromPrevious", async (t) => {

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

    try{

        // t=0: a request 15s before the failure - OUTSIDE a 10s context window, must be excluded.
        accounting.withOrigin("scheduler:trending", () => accounting.record({ method: "GET", subPath: "/v1/market/rank", status: 200 }));
        t.mock.timers.tick(15000);

        // t=15000: inside the 10s window (5s before failure).
        accounting.withOrigin("usd-to-sol-price-probe", () => accounting.record({
            method: "GET", subPath: "/v1/trade/quote", status: 200,
            url: "https://openapi.gmgn.ai/v1/trade/quote?input_token=SOL&output_token=USDC"
        }));
        t.mock.timers.tick(4700);

        // t=19700: 300ms before the failure - a real burst (small gap).
        accounting.withOrigin("execution:buy-quote", () => accounting.record({
            method: "GET", subPath: "/v1/trade/quote", status: 200,
            url: "https://openapi.gmgn.ai/v1/trade/quote?input_token=SOL&output_token=CandidateToken333"
        }));
        t.mock.timers.tick(300);

        // t=20000: the first real 429.
        accounting.withOrigin("execution:submit-swap", () => accounting.record({ method: "POST", subPath: "/v1/trade/swap", status: 429 }));

        const timeline = accounting.getTimelineBeforeFirstFailure({ contextMs: 10000 });

        assert.equal(timeline.found, true);
        assert.equal(timeline.firstFailureEndpoint, "POST /v1/trade/swap");
        assert.equal(timeline.firstFailureOrigin, "execution:submit-swap");
        assert.equal(timeline.requestCountInWindow, 3, "the t=0 request (15s before failure) must be excluded from a 10s context window - only the 3 requests within the last 10s, including the failure itself, are included");

        assert.equal(timeline.rows[0].origin, "usd-to-sol-price-probe");
        assert.equal(timeline.rows[0].gapMsFromPrevious, null, "the first row in the timeline has no previous row to gap against");

        assert.equal(timeline.rows[1].origin, "execution:buy-quote");
        assert.equal(timeline.rows[1].gapMsFromPrevious, 4700);
        assert.deepEqual(timeline.rows[1].candidateInfo, { input_token: "SOL", output_token: "CandidateToken333" });

        assert.equal(timeline.rows[2].origin, "execution:submit-swap");
        assert.equal(timeline.rows[2].status, 429);
        assert.equal(timeline.rows[2].gapMsFromPrevious, 300, "a 300ms gap right before the failure is exactly the kind of burst this timeline exists to surface");

    }
    finally{
        t.mock.timers.reset();
    }

});

test("getTimelineBeforeFirstFailure: picks the FIRST failure, not the last, when multiple exist in the window", async (t) => {

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

    try{

        accounting.withOrigin("execution:submit-swap", () => accounting.record({ method: "POST", subPath: "/v1/trade/swap", status: 429 }));
        t.mock.timers.tick(2000);
        accounting.withOrigin("execution:submit-swap", () => accounting.record({ method: "POST", subPath: "/v1/trade/swap", status: 429 }));

        const timeline = accounting.getTimelineBeforeFirstFailure({ contextMs: 10000 });

        assert.equal(timeline.found, true);
        assert.equal(timeline.requestCountInWindow, 1, "only the FIRST failure anchors the timeline - the second one is outside its own preceding context in this test and must not replace it");

    }
    finally{
        t.mock.timers.reset();
    }

});

test("getTimelineBeforeFirstFailure: a custom failureStatuses filter (e.g. TIMEOUT instead of 429) works", () => {

    accounting.withOrigin("scheduler:trending", () => accounting.record({ method: "GET", subPath: "/v1/market/rank", status: 429 }));
    accounting.withOrigin("scheduler:trenches", () => accounting.record({ method: "POST", subPath: "/v1/trenches", status: "TIMEOUT" }));

    const timeline = accounting.getTimelineBeforeFirstFailure({ failureStatuses: ["TIMEOUT"] });

    assert.equal(timeline.found, true);
    assert.equal(timeline.firstFailureEndpoint, "POST /v1/trenches", "must match on the requested status only, ignoring the earlier 429 since it wasn't asked for");

});

test("formatTimeline: found:false renders the honest message, found:true renders every requested column", () => {

    const empty = accounting.getTimelineBeforeFirstFailure();
    assert.ok(accounting.formatTimeline(empty).includes("Tidak ada request"));

    accounting.withOrigin("execution:submit-swap", () => accounting.record({
        method: "POST", subPath: "/v1/trade/swap", status: 429,
        url: "https://openapi.gmgn.ai/v1/trade/swap?input_token=SOL&output_token=TokenABC"
    }));

    const timeline = accounting.getTimelineBeforeFirstFailure();
    const table = accounting.formatTimeline(timeline);

    assert.ok(table.includes("Timestamp"));
    assert.ok(table.includes("Candidate/Token"));
    assert.ok(table.includes("execution:submit-swap"));
    assert.ok(table.includes("TokenABC"));

});
