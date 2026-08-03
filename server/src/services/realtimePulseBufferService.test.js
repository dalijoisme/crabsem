// services/realtimePulseBufferService.test.js - Arjuna V4 Phase 2. Proves
// the in-memory rolling buffer's own contract: bounded to BUFFER_SIZE
// (3), oldest-first ordering, explicit eviction (the fix for the original
// design's vague "ages out" language - see PHASE2_ARCHITECTURE_REVIEW.md
// Section 1/8), and warm-start seeding. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const bufferService = require("./realtimePulseBufferService");
const realtimePulseConfig = require("../config/realtimePulseConfig");

test.afterEach(() => {
    bufferService.clear();
});

test("recordPoint accumulates up to BUFFER_SIZE points, oldest first", () => {

    const token = "TOKEN_A";

    bufferService.recordPoint(token, { recordedAtMs: 1000, price: 1 });
    bufferService.recordPoint(token, { recordedAtMs: 2000, price: 2 });
    bufferService.recordPoint(token, { recordedAtMs: 3000, price: 3 });

    const buf = bufferService.getBuffer(token);
    assert.equal(buf.length, realtimePulseConfig.BUFFER_SIZE);
    assert.deepEqual(buf.map(p => p.price), [1, 2, 3]);

});

test("recordPoint never exceeds BUFFER_SIZE - oldest point is dropped, not the newest", () => {

    const token = "TOKEN_B";

    bufferService.recordPoint(token, { recordedAtMs: 1000, price: 1 });
    bufferService.recordPoint(token, { recordedAtMs: 2000, price: 2 });
    bufferService.recordPoint(token, { recordedAtMs: 3000, price: 3 });
    bufferService.recordPoint(token, { recordedAtMs: 4000, price: 4 });

    const buf = bufferService.getBuffer(token);
    assert.equal(buf.length, 3, "must never grow past BUFFER_SIZE regardless of how many real polls arrive");
    assert.deepEqual(buf.map(p => p.price), [2, 3, 4], "the OLDEST point must be dropped, the newest 3 kept");

});

test("getBuffer for an unknown token returns an empty array, never null/undefined/fabricated", () => {
    assert.deepEqual(bufferService.getBuffer("NEVER_SEEN"), []);
});

test("seedBuffer warm-starts a token that has no in-memory points yet", () => {

    const token = "TOKEN_C";
    bufferService.seedBuffer(token, [
        { recordedAtMs: 1000, price: 1 },
        { recordedAtMs: 2000, price: 2 }
    ]);

    assert.deepEqual(bufferService.getBuffer(token).map(p => p.price), [1, 2]);

});

test("seedBuffer never overwrites a token that already has real in-memory points", () => {

    const token = "TOKEN_D";
    bufferService.recordPoint(token, { recordedAtMs: 5000, price: 99 });

    bufferService.seedBuffer(token, [{ recordedAtMs: 1000, price: 1 }]);

    assert.deepEqual(bufferService.getBuffer(token).map(p => p.price), [99], "a real, already-buffered point must never be silently replaced by a warm-start seed");

});

test("seedBuffer with more rows than BUFFER_SIZE keeps only the most recent", () => {

    const token = "TOKEN_E";
    bufferService.seedBuffer(token, [
        { recordedAtMs: 1000, price: 1 },
        { recordedAtMs: 2000, price: 2 },
        { recordedAtMs: 3000, price: 3 },
        { recordedAtMs: 4000, price: 4 }
    ]);

    assert.deepEqual(bufferService.getBuffer(token).map(p => p.price), [2, 3, 4]);

});

test("evictExcept removes buffered tokens no longer in the active fresh-universe set", () => {

    bufferService.recordPoint("TOKEN_KEEP", { recordedAtMs: 1000, price: 1 });
    bufferService.recordPoint("TOKEN_DROP", { recordedAtMs: 1000, price: 1 });

    const evicted = bufferService.evictExcept(new Set(["TOKEN_KEEP"]));

    assert.equal(evicted, 1);
    assert.deepEqual(bufferService.getBuffer("TOKEN_KEEP").map(p => p.price), [1]);
    assert.deepEqual(bufferService.getBuffer("TOKEN_DROP"), [], "a token no longer in the fresh universe must be fully evicted, not merely stop being updated - this is the fix for the original design's memory-leak gap");

});

test("evictExcept accepts a plain array too, not only a Set", () => {

    bufferService.recordPoint("TOKEN_F", { recordedAtMs: 1000, price: 1 });

    const evicted = bufferService.evictExcept(["TOKEN_F"]);

    assert.equal(evicted, 0);
    assert.equal(bufferService.getBuffer("TOKEN_F").length, 1);

});

test("size() reflects the real number of currently-buffered tokens", () => {

    assert.equal(bufferService.size(), 0);

    bufferService.recordPoint("TOKEN_G", { recordedAtMs: 1000, price: 1 });
    bufferService.recordPoint("TOKEN_H", { recordedAtMs: 1000, price: 1 });

    assert.equal(bufferService.size(), 2);

});
