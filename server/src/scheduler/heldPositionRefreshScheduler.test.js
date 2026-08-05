// scheduler/heldPositionRefreshScheduler.test.js - Held-Position Refresh
// Architecture, Phase 1 (Design 1: Centralized Refresh Loop). Pure
// wiring test, same convention as scheduler/exitEvaluationScheduler.test.js -
// every dependency stubbed at the module-object level, ondemandService
// injected directly into runOnce() (no real GMGN credentials needed).
// Proves the actual root-cause fix: a token held by two different
// RUNNING users (or twice by the same user) is fetched exactly ONCE per
// tick, and the result lands in services/heldPositionMarketStore.js for
// services/tradingBotEngine.js's refreshStaleHeldToken() to read.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const tradingBotRepository = require("../repositories/tradingBotRepository");
const heldPositionMarketStore = require("../services/heldPositionMarketStore");

const scheduler = require("./heldPositionRefreshScheduler");

function stub(obj, method, fn){
    const original = obj[method];
    obj[method] = fn;
    return () => { obj[method] = original; };
}

test.afterEach(() => {
    heldPositionMarketStore.clear();
});

test("collectOpenPositionTokenAddresses unions every RUNNING user's open positions, de-duplicated", () => {

    const positionsByUser = {
        7001: [{ token_address: "SHARED_TOKEN" }, { token_address: "USER_A_ONLY" }],
        7002: [{ token_address: "SHARED_TOKEN" }, { token_address: "USER_B_ONLY" }]
    };

    const restores = [
        stub(tradingBotRepository, "findRunningUserIds", () => [7001, 7002]),
        stub(tradingBotRepository, "findOpenPositions", (userId) => positionsByUser[userId] || [])
    ];

    try{

        const addresses = scheduler.collectOpenPositionTokenAddresses();
        assert.deepEqual([...addresses].sort(), ["SHARED_TOKEN", "USER_A_ONLY", "USER_B_ONLY"], "a token held by two different users must appear exactly once");

    }
    finally{
        restores.forEach(restore => restore());
    }

});

test("collectOpenPositionTokenAddresses is a real empty set, never fabricated, when no user is RUNNING", () => {

    const restores = [
        stub(tradingBotRepository, "findRunningUserIds", () => []),
        stub(tradingBotRepository, "findOpenPositions", () => { throw new Error("must never be called - there are no running users"); })
    ];

    try{
        assert.equal(scheduler.collectOpenPositionTokenAddresses().size, 0);
    }
    finally{
        restores.forEach(restore => restore());
    }

});

test("runOnce fetches each unique token exactly ONCE per tick and writes it into heldPositionMarketStore", async () => {

    const positionsByUser = {
        8001: [{ token_address: "TOKEN_ONE" }],
        8002: [{ token_address: "TOKEN_ONE" }, { token_address: "TOKEN_TWO" }]
    };

    const fetchCallsByToken = {};
    const fakeOndemand = {
        async getTokenPoolInfo(chain, address){
            fetchCallsByToken[address] = (fetchCallsByToken[address] || 0) + 1;
            return { data: { liquidity: "1000" } };
        },
        async getTokenKline(chain, address){
            return { data: { list: [{ close: address === "TOKEN_ONE" ? "1.5" : "2.5" }] } };
        }
    };

    const restores = [
        stub(tradingBotRepository, "findRunningUserIds", () => [8001, 8002]),
        stub(tradingBotRepository, "findOpenPositions", (userId) => positionsByUser[userId] || [])
    ];

    try{

        const result = await scheduler.runOnce(fakeOndemand);

        assert.equal(result.tokenCount, 2, "exactly 2 unique tokens across both users, not 3 (one position each) or 4 (one call per position)");
        assert.equal(fetchCallsByToken.TOKEN_ONE, 1, "TOKEN_ONE is held by BOTH users but must only be fetched once this tick - the entire point of centralizing the refresh");
        assert.equal(fetchCallsByToken.TOKEN_TWO, 1);

        assert.equal(heldPositionMarketStore.getFresh("TOKEN_ONE", 60000).price, 1.5);
        assert.equal(heldPositionMarketStore.getFresh("TOKEN_TWO", 60000).price, 2.5);

    }
    finally{
        restores.forEach(restore => restore());
    }

});

test("a single token's fetch failure is logged and skipped, never aborts the rest of the tick's tokens", async () => {

    const positionsByUser = { 9001: [{ token_address: "GOOD_TOKEN" }, { token_address: "BAD_TOKEN" }] };

    const fakeOndemand = {
        async getTokenPoolInfo(chain, address){
            if(address === "BAD_TOKEN") throw new Error("GMGN unreachable (simulated)");
            return { data: { liquidity: "1000" } };
        },
        async getTokenKline(){
            return { data: { list: [{ close: "1.0" }] } };
        }
    };

    const restores = [
        stub(tradingBotRepository, "findRunningUserIds", () => [9001]),
        stub(tradingBotRepository, "findOpenPositions", (userId) => positionsByUser[userId] || [])
    ];

    try{

        const result = await scheduler.runOnce(fakeOndemand);

        assert.equal(result.tokenCount, 2);
        assert.equal(result.errorCount, 1, "exactly one token failed");
        assert.ok(heldPositionMarketStore.getFresh("GOOD_TOKEN", 60000), "the OTHER token must still have been fetched and stored despite BAD_TOKEN's failure");
        assert.equal(heldPositionMarketStore.getFresh("BAD_TOKEN", 60000), null, "the failed token must never get a fabricated store entry");

    }
    finally{
        restores.forEach(restore => restore());
    }

});

test("runOnce with no RUNNING users is a cheap no-op - zero tokens, never calls ondemandService", async () => {

    const restores = [
        stub(tradingBotRepository, "findRunningUserIds", () => []),
        stub(tradingBotRepository, "findOpenPositions", () => { throw new Error("must never be called"); })
    ];

    const fakeOndemand = {
        async getTokenPoolInfo(){ throw new Error("must never be called - no open positions exist"); },
        async getTokenKline(){ throw new Error("must never be called - no open positions exist"); }
    };

    try{

        const result = await scheduler.runOnce(fakeOndemand);
        assert.equal(result.tokenCount, 0);
        assert.equal(result.errorCount, 0);

    }
    finally{
        restores.forEach(restore => restore());
    }

});

test("getTickHealth reflects a real, just-updated timestamp and token count after runOnce()", async () => {

    const restores = [
        stub(tradingBotRepository, "findRunningUserIds", () => [1234]),
        stub(tradingBotRepository, "findOpenPositions", () => [{ token_address: "HEALTH_TOKEN" }])
    ];

    const fakeOndemand = {
        async getTokenPoolInfo(){ return { data: { liquidity: "500" } }; },
        async getTokenKline(){ return { data: { list: [{ close: "1.1" }] } }; }
    };

    try{

        const beforeTickAt = Date.now();
        await scheduler.runOnce(fakeOndemand);

        const health = scheduler.getTickHealth();
        assert.ok(health.lastTickAt, "a real ISO timestamp must be recorded after runOnce()");
        assert.ok(Date.parse(health.lastTickAt) >= beforeTickAt);
        assert.equal(health.lastTickTokenCount, 1);
        assert.equal(health.lastTickErrorCount, 0);
        assert.equal(health.stuck, false);

    }
    finally{
        restores.forEach(restore => restore());
    }

});

test("a second overlapping runOnce() is skipped while the first is still in flight - never runs concurrently with itself", async () => {

    const restores = [
        stub(tradingBotRepository, "findRunningUserIds", () => [5555]),
        stub(tradingBotRepository, "findOpenPositions", () => [{ token_address: "SLOW_TOKEN" }])
    ];

    let resolveFirstFetch;
    const firstFetchStarted = new Promise(resolve => { resolveFirstFetch = resolve; });
    let fetchCallCount = 0;

    const slowOndemand = {
        async getTokenPoolInfo(){
            fetchCallCount++;
            resolveFirstFetch();
            return new Promise(() => {}); // never resolves - simulates a genuinely slow/hung fetch
        },
        async getTokenKline(){ return new Promise(() => {}); }
    };

    try{

        const firstRun = scheduler.runOnce(slowOndemand); // fire-and-forget, deliberately never awaited here
        await firstFetchStarted;

        const secondResult = await scheduler.runOnce(slowOndemand);

        assert.equal(secondResult, null, "an overlapping tick must be skipped outright while the previous one is still in flight");
        assert.equal(fetchCallCount, 1, "the skipped tick must never have started its own fetch");

        void firstRun; // left permanently in flight - this test process exits at test-file end regardless

    }
    finally{
        restores.forEach(restore => restore());
    }

});
