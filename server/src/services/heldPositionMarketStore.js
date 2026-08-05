// services/heldPositionMarketStore.js - Held-Position Refresh
// Architecture, Phase 1 (Design 1: Centralized Refresh Loop). The
// in-memory, hot-path store scheduler/heldPositionRefreshScheduler.js
// writes into and services/tradingBotEngine.js's refreshStaleHeldToken()
// reads from - keyed by token_address, holding the freshest real
// price/liquidity this process has fetched for that token.
//
// This is what lets N open positions (across every RUNNING user, paper
// AND live) sharing the same token read ONE real fetch instead of each
// triggering their own - the direct fix for the forensic audit's root
// cause (64.5% of GMGN request volume: two independent schedulers, each
// fetching per-position, per-cycle, with no coordination between them).
//
// Same "explicit, bounded, never-fabricated" shape as
// services/realtimePulseBufferService.js: every entry carries its OWN
// real fetchedAt (Date.now() at the moment it was recorded), and a
// reader must explicitly ask for freshness (getFresh) rather than ever
// receiving something implicitly treated as current. A token with no
// entry, or an entry older than the caller's own maxAgeMs, is a real
// miss - the caller's job (see tradingBotEngine.js) to fall back to a
// direct fetch, never this store's job to guess or extend an old value.

const store = new Map(); // token_address -> { price, liquidity, fetchedAt }

// Real, already-fetched price/liquidity for one token. `fetchedAt` is
// stamped here (Date.now()), never accepted from the caller - this store
// is the single source of truth for "how old is this", exactly like
// realtimePulseBufferService.js's own real-timestamp convention.
function set(tokenAddress, { price, liquidity }){

    store.set(tokenAddress, { price, liquidity, fetchedAt: Date.now() });

}

// Real entry regardless of age, or null if this token was never fetched -
// used for observability/debugging, never for a trading decision (see
// getFresh below for that).
function get(tokenAddress){

    return store.get(tokenAddress) || null;

}

// The real read path for exit evaluation: an entry is only ever returned
// if it is no older than maxAgeMs - so "no fresh-enough data" (this
// token was never fetched, or the refresh loop is behind) is always an
// honest null, never a silently-stale value. Callers must treat null as
// "fall back to a direct, on-demand fetch", never as "skip the check".
function getFresh(tokenAddress, maxAgeMs){

    const entry = store.get(tokenAddress);

    if(!entry) return null;

    if((Date.now() - entry.fetchedAt) > maxAgeMs) return null;

    return entry;

}

// Real-time observability fact (mirrors realtimePulseBufferService.js's
// own size()) - how many tokens currently have a stored fetch, right
// now. Not a trading signal.
function size(){
    return store.size;
}

// Test-only reset - same convention as realtimePulseBufferService.js's
// clear(), so each test starts from a known-empty store instead of
// relying on cross-test isolation.
function clear(){
    store.clear();
}

module.exports = { set, get, getFresh, size, clear };
