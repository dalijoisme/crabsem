// repositories/gmgnTokenRepository.test.js - Fresh-Universe-Goes-To-Zero
// root cause fix. Real production incident: PM2/collector/scheduler all
// reported healthy, gmgn_tokens.updated_at was provably fresh (seconds_stale
// in single digits), yet
// freshUniverseService.getBuyCandidateUniverse()/getFreshTokens() returned
// ZERO tokens. Traced to this file's own upsertStmt: the ON CONFLICT
// clause overwrote market_cap unconditionally with whatever came in the
// latest batch - a single GMGN response missing/omitting market_cap for
// its refreshed tokens (services/tokenTransformer.js's
// numberOrNull(token.market_cap) correctly maps "field absent" to null,
// per this codebase's existing "honest null, never fabricate"
// convention) silently nulled market_cap for every token touched that
// tick, even though updated_at legitimately advanced. getFreshTokens()'s
// WHERE clause (updated_at >= window AND market_cap > @minMarketCap)
// then excluded all of them - and since the fresh window only ever
// holds the last 1-2 ticks' worth of refreshed rows to begin with, that
// alone was enough to drive freshUniverseCount to 0 while every
// liveness signal (collector health, scheduler tick health, DB
// staleness) looked perfectly normal.
//
// Fix: market_cap = COALESCE(excluded.market_cap, market_cap) - a
// missing field in this tick's response no longer erases the last
// known-good value. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const gmgnTokenRepository = require("./gmgnTokenRepository");
const freshUniverseService = require("../services/freshUniverseService");
const db = require("../database/connection");

const PREFIX = "GMGNTOKENREPO_TEST_";

function baseToken(address, overrides = {}){
    return {
        tokenAddress: address, symbol: "SYM", name: "Name", chain: "sol", logo: null,
        marketCap: 100000, liquidity: 5000, price: 0.001,
        priceChange5m: 1, priceChange1h: 2, priceChange24h: null,
        volume5m: null, volume1h: 1000, volume24h: null,
        buys5m: null, sells5m: null, holders: 100, fdv: 100000,
        launchTimestamp: Math.floor(Date.now() / 1000) - 3600,
        rawJson: "{}",
        ...overrides
    };
}

test.afterEach(() => {
    db.prepare("DELETE FROM gmgn_tokens WHERE token_address LIKE ?").run(`${PREFIX}%`);
});

test("re-upserting with market_cap missing (null) preserves the last known-good market_cap", () => {

    const address = `${PREFIX}A`;

    gmgnTokenRepository.upsertTokens([baseToken(address, { marketCap: 123456 })]);
    assert.equal(gmgnTokenRepository.getTokenByAddress(address).market_cap, 123456);

    // Simulates GMGN's response omitting market_cap for this token on a
    // later tick - transformToken() maps that to marketCap: null, same
    // as a real degraded/partial response.
    gmgnTokenRepository.upsertTokens([baseToken(address, { marketCap: null })]);

    const row = gmgnTokenRepository.getTokenByAddress(address);
    assert.equal(row.market_cap, 123456, "market_cap must survive a batch that reports no market_cap at all");

});

test("re-upserting with a real market_cap of 0 DOES overwrite (0 is real data, not 'missing')", () => {

    const address = `${PREFIX}B`;

    gmgnTokenRepository.upsertTokens([baseToken(address, { marketCap: 500 })]);
    gmgnTokenRepository.upsertTokens([baseToken(address, { marketCap: 0 })]);

    assert.equal(gmgnTokenRepository.getTokenByAddress(address).market_cap, 0, "an honest 0 from GMGN must still overwrite - only NULL (absent) is protected");

});

test("updated_at still advances on every upsert even when market_cap is carried forward", async () => {

    const address = `${PREFIX}C`;

    gmgnTokenRepository.upsertTokens([baseToken(address, { marketCap: 42 })]);
    const first = gmgnTokenRepository.getTokenByAddress(address).updated_at;

    await new Promise(resolve => setTimeout(resolve, 1100)); // SQLite CURRENT_TIMESTAMP has 1s resolution

    gmgnTokenRepository.upsertTokens([baseToken(address, { marketCap: null })]);
    const second = gmgnTokenRepository.getTokenByAddress(address).updated_at;

    assert.ok(second > first, "updated_at must still be bumped even when market_cap itself is carried forward from the previous value");

});

// The actual regression the production incident asked for: fresh
// universe must never be empty while a token's updated_at is genuinely
// inside the freshness window, regardless of what any single upstream
// response batch did or didn't include for market_cap.
test("getFreshTokens/getBuyCandidateUniverse never drop a token whose updated_at is inside the freshness window", () => {

    const addresses = [`${PREFIX}D1`, `${PREFIX}D2`, `${PREFIX}D3`];

    gmgnTokenRepository.upsertTokens(addresses.map(a => baseToken(a, { marketCap: 777 })));

    const before = freshUniverseService.getBuyCandidateUniverse();
    const beforeAddresses = before.tokens.map(t => t.token_address);
    for(const a of addresses) assert.ok(beforeAddresses.includes(a), `${a} should be in the fresh universe before the degraded re-upsert`);

    // Degraded batch: same tokens seen again this tick (updated_at
    // refreshes), but GMGN's response for this tick has no market_cap.
    gmgnTokenRepository.upsertTokens(addresses.map(a => baseToken(a, { marketCap: null })));

    const after = freshUniverseService.getBuyCandidateUniverse();
    const afterAddresses = after.tokens.map(t => t.token_address);

    for(const a of addresses){
        assert.ok(
            afterAddresses.includes(a),
            `${a} has a fresh updated_at and a previously-known-good market_cap - it must still appear in the fresh universe, not be silently dropped to fresh=0`
        );
    }

});
