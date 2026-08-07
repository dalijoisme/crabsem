// collectors/gmgn/authClient.test.js - Held-Position Refresh
// Architecture, Phase 1 (Design 2: Request Coalescing). Proves the
// coalescing contract added to createGmgnClient()'s authExistRequest:
//   - OFF by default (coalesceRequests unset/false) - every existing
//     caller (services/execution/index.js's swap-only client,
//     collectors/gmgn/verifyAuth.js, etc.) is byte-for-byte unaffected.
//   - ON (coalesceRequests: true, services/marketDataGateway.js's own
//     instance) - two callers asking for the exact same logical request
//     while one is in flight share ONE real fetch, never two.
//   - Never a cache: once the shared promise settles, the NEXT call
//     always goes live again.
//   - Two DIFFERENT logical requests (different address) never coalesce.
// global.fetch is stubbed directly - no real network call in this file.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGmgnClient } = require("./authClient");

function fakeOkResponse(data){
    return { status: 200, text: async () => JSON.stringify({ code: 0, data }) };
}

test("coalesceRequests OFF (default) - two concurrent identical requests each trigger their own real fetch", async () => {

    const originalFetch = global.fetch;
    let fetchCallCount = 0;

    global.fetch = async () => {
        fetchCallCount++;
        return fakeOkResponse({ liquidity: "100" });
    };

    try{

        const client = createGmgnClient({ apiKey: "test-key", host: "https://gmgn.example.invalid" });

        await Promise.all([
            client.getTokenPoolInfo("sol", "ADDR_A"),
            client.getTokenPoolInfo("sol", "ADDR_A")
        ]);

        assert.equal(fetchCallCount, 2, "without coalescing enabled, two concurrent identical calls must remain two independent real fetches - zero behavior change for every existing caller");

    }
    finally{
        global.fetch = originalFetch;
    }

});

test("coalesceRequests ON - two concurrent identical requests share ONE real fetch", async () => {

    const originalFetch = global.fetch;
    let fetchCallCount = 0;

    global.fetch = async () => {
        fetchCallCount++;
        return fakeOkResponse({ liquidity: "200" });
    };

    try{

        const client = createGmgnClient({ apiKey: "test-key", host: "https://gmgn.example.invalid", coalesceRequests: true });

        // Both calls issued back-to-back, synchronously, before either
        // awaits anything - the in-flight map entry for call1 is written
        // synchronously (see authClient.js's own coalesce()) before
        // control ever returns to this line, so call2 is guaranteed to
        // observe it already in flight, no manual synchronization needed.
        const call1 = client.getTokenPoolInfo("sol", "ADDR_B");
        const call2 = client.getTokenPoolInfo("sol", "ADDR_B");

        const [result1, result2] = await Promise.all([call1, call2]);

        assert.equal(fetchCallCount, 1, "two callers asking for the exact same (method+subPath+params) request while one is in flight must share ONE real HTTP call");
        assert.equal(result1.data.liquidity, "200");
        assert.equal(result2.data.liquidity, "200");
        assert.deepEqual(result1, result2, "both coalesced callers must receive the same real, unmodified result");

    }
    finally{
        global.fetch = originalFetch;
    }

});

test("coalesceRequests ON - never becomes a cache: the NEXT call after settling goes live again", async () => {

    const originalFetch = global.fetch;
    let fetchCallCount = 0;

    global.fetch = async () => {
        fetchCallCount++;
        return fakeOkResponse({ liquidity: String(fetchCallCount * 100) });
    };

    try{

        const client = createGmgnClient({ apiKey: "test-key", host: "https://gmgn.example.invalid", coalesceRequests: true });

        const first = await client.getTokenPoolInfo("sol", "ADDR_C");
        const second = await client.getTokenPoolInfo("sol", "ADDR_C"); // fired only AFTER the first fully settled

        assert.equal(fetchCallCount, 2, "coalescing must only apply while a request is genuinely in flight - a sequential second call is a real, independent fetch, never served from a stale share");
        assert.equal(first.data.liquidity, "100");
        assert.equal(second.data.liquidity, "200", "the second call must see a genuinely fresh response, proving it was not silently reused from the first");

    }
    finally{
        global.fetch = originalFetch;
    }

});

test("coalesceRequests ON - two requests for DIFFERENT tokens never coalesce", async () => {

    const originalFetch = global.fetch;
    let fetchCallCount = 0;

    global.fetch = async () => {
        fetchCallCount++;
        return fakeOkResponse({ liquidity: "300" });
    };

    try{

        const client = createGmgnClient({ apiKey: "test-key", host: "https://gmgn.example.invalid", coalesceRequests: true });

        await Promise.all([
            client.getTokenPoolInfo("sol", "ADDR_D1"),
            client.getTokenPoolInfo("sol", "ADDR_D2")
        ]);

        assert.equal(fetchCallCount, 2, "different logical requests (different token address) must never be merged into one");

    }
    finally{
        global.fetch = originalFetch;
    }

});

test("coalesceRequests ON - a rejected in-flight request is shared too, then clears so the next call retries live", async () => {

    const originalFetch = global.fetch;
    let fetchCallCount = 0;

    global.fetch = async () => {
        fetchCallCount++;
        if(fetchCallCount === 1) throw new Error("simulated network failure");
        return fakeOkResponse({ liquidity: "400" });
    };

    try{

        const client = createGmgnClient({ apiKey: "test-key", host: "https://gmgn.example.invalid", coalesceRequests: true });

        const call1 = client.getTokenPoolInfo("sol", "ADDR_E");
        const call2 = client.getTokenPoolInfo("sol", "ADDR_E");

        await assert.rejects(call1);
        await assert.rejects(call2, undefined, "the coalesced sibling must see the SAME real failure, never a fabricated success");
        assert.equal(fetchCallCount, 1, "both callers must have shared the one real (failed) fetch");

        const call3 = await client.getTokenPoolInfo("sol", "ADDR_E");
        assert.equal(fetchCallCount, 2, "after the failed in-flight entry clears, the next call must go live again, not stay permanently poisoned");
        assert.equal(call3.data.liquidity, "400");

    }
    finally{
        global.fetch = originalFetch;
    }

});

test("coalesceRequests ON - a permanently-hung in-flight entry (fetch resolves but body read never settles) does not block callers forever past coalesceTtlMs", async () => {

    const originalFetch = global.fetch;
    let fetchCallCount = 0;

    global.fetch = async () => {
        fetchCallCount++;
        if(fetchCallCount === 1){
            // Simulates GMGN returning headers fine but then stalling
            // mid-body forever - fetchWithTimeout's AbortSignal.timeout
            // has already resolved fetch() by this point, so nothing
            // times out `text()` here. This is the real hang scenario
            // the coalesceTtlMs staleness bypass exists for.
            return { status: 200, text: () => new Promise(() => {}) };
        }
        return fakeOkResponse({ liquidity: "500" });
    };

    try{

        const client = createGmgnClient({ apiKey: "test-key", host: "https://gmgn.example.invalid", coalesceRequests: true, coalesceTtlMs: 20 });

        const call1 = client.getTokenPoolInfo("sol", "ADDR_F"); // never settles - left dangling on purpose

        await new Promise(resolve => setTimeout(resolve, 30)); // past coalesceTtlMs

        const call2 = await client.getTokenPoolInfo("sol", "ADDR_F");

        assert.equal(fetchCallCount, 2, "a caller arriving after coalesceTtlMs must get a genuinely fresh request instead of joining the dead promise from call1");
        assert.equal(call2.data.liquidity, "500");

        void call1; // intentionally never awaited/settled - proves the fix doesn't depend on the old promise ever resolving

    }
    finally{
        global.fetch = originalFetch;
    }

});
