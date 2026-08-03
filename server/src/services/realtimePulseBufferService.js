// services/realtimePulseBufferService.js - Arjuna V4 Phase 2. The
// in-memory, hot-path tier of the Realtime Pulse poll history - a bounded,
// fixed-size (config/realtimePulseConfig.js's BUFFER_SIZE, 3 points)
// rolling buffer per token, keyed by token_address. This is the ONLY tier
// the BUY-tick (15s) and exit-evaluation loop (1-30s) ever read - neither
// ever waits on a DB round-trip or a fresh computation (see
// PHASE2_ARCHITECTURE_REVIEW.md Section 1/7).
//
// Every buffered point carries its OWN real timestamp (Date.now() at the
// moment it was recorded) - never an assumed fixed interval. This is a
// direct fix for a real gap found in the original design during the
// architecture review: GMGN's own collector batch has been observed to
// take 57.5s in this exact codebase (far past the nominal 30s), so
// anything computing a delta must divide by the REAL elapsed time between
// two points, never a constant.
//
// Eviction is explicit, not implicit. The original design said tokens
// "age out" of the fresh universe - that was vague enough to be a real
// memory-leak risk (a token that permanently stops trending would
// otherwise sit in this Map forever, since token_address is never
// reused). evictExcept() is the fix: called once per Pulse tick with the
// CURRENT fresh-universe token set, it removes every buffer entry not in
// that set.

const realtimePulseConfig = require("../config/realtimePulseConfig");

const buffers = new Map(); // token_address -> array of points, oldest first, length <= BUFFER_SIZE

// A new real poll for one token. Appends to that token's buffer,
// trimming from the front once BUFFER_SIZE is exceeded - never grows
// unbounded per token, regardless of how long a token stays in the fresh
// universe.
function recordPoint(tokenAddress, point){

    const existing = buffers.get(tokenAddress) || [];

    const updated = [...existing, point];

    while(updated.length > realtimePulseConfig.BUFFER_SIZE){
        updated.shift();
    }

    buffers.set(tokenAddress, updated);

}

// Real, ordered (oldest first) buffer for one token - may hold fewer than
// BUFFER_SIZE points (a token just discovered this tick, or just after a
// process restart before the buffer has refilled). Callers must treat a
// short buffer as "insufficient history", never pad or guess a missing
// point - same "never fabricate" convention every other module in this
// codebase already follows.
function getBuffer(tokenAddress){
    return buffers.get(tokenAddress) || [];
}

// Seeds one token's buffer directly - used once at process boot to
// warm-start from realtimePulseRepository's durable rows (see
// realtimePulseService.js's bootstrap), so a restart doesn't force every
// token back through a fully cold multi-tick ramp-up. Only ever called
// with real, already-persisted rows - never fabricated data. A token
// that already has buffered points (should not happen at boot, but
// defensive) is left untouched rather than overwritten.
function seedBuffer(tokenAddress, points){
    if(buffers.has(tokenAddress)) return;
    if(!points.length) return;
    buffers.set(tokenAddress, points.slice(-realtimePulseConfig.BUFFER_SIZE));
}

// Explicit eviction - the fix for the original design's vague "ages out"
// language. `activeTokenAddresses` is the CURRENT fresh-universe set
// (Set or array); any buffered token not in it is removed outright. Must
// be called every Pulse tick (see realtimePulseService.js) so a token
// that permanently stops trending is bounded to at most one extra tick of
// memory, never unbounded growth.
function evictExcept(activeTokenAddresses){

    const activeSet = activeTokenAddresses instanceof Set ? activeTokenAddresses : new Set(activeTokenAddresses);

    let evicted = 0;

    for(const tokenAddress of buffers.keys()){
        if(!activeSet.has(tokenAddress)){
            buffers.delete(tokenAddress);
            evicted++;
        }
    }

    return evicted;

}

// Real-time observability fact (services/health.js/adminService.js) - how
// many tokens are currently buffered, right now. Not a trading signal,
// purely a memory-footprint/coverage fact.
function size(){
    return buffers.size;
}

// Test-only reset - mirrors the module-level-state reset pattern this
// codebase's own scheduler test files already need (see
// scheduler/tradingBotScheduler.test.js's own header comment on why each
// test uses a fresh key rather than relying on cross-test isolation).
function clear(){
    buffers.clear();
}

module.exports = { recordPoint, getBuffer, seedBuffer, evictExcept, size, clear };
