// repositories/tradingBotCandidateSightingsRepository.js - Momentum
// Validation System sprint (Sprint 5). Per-user record of every token
// that user's own live cycle marked BUY/STRONG BUY at least once -
// mirrors repositories/benchmarkCandidateSightingsRepository.js's own
// already-proven shape exactly (that one is scoped to a benchmark run
// participant; this one to a real user). Powers Average Entry Delay:
// how long CRAB was already eyeing a token before it was actually bought.

const db = require("../database/connection");

const upsertSightingStmt = db.prepare(`
    INSERT INTO trading_bot_candidate_sightings (user_id, token_address, token_symbol, entry_price_at_first_sight, first_seen_at, last_seen_at)
    VALUES (@userId, @tokenAddress, @tokenSymbol, @entryPrice, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, token_address) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP
`);

// Called once per BUY/STRONG BUY token per user per cycle - cheap
// (bounded by this cycle's real qualified-candidate count, never by the
// full scan universe). entry_price_at_first_sight is only ever written
// on the FIRST sighting (the INSERT branch) - a re-sighting never
// overwrites it, so it stays a real "price when first noticed" baseline.
function recordSighting(userId, { tokenAddress, tokenSymbol, entryPrice }){
    upsertSightingStmt.run({ userId, tokenAddress, tokenSymbol: tokenSymbol ?? null, entryPrice: entryPrice ?? null });
}

function findByUserAndToken(userId, tokenAddress){
    return db.prepare(
        "SELECT * FROM trading_bot_candidate_sightings WHERE user_id = ? AND token_address = ?"
    ).get(userId, tokenAddress) ?? null;
}

module.exports = { recordSighting, findByUserAndToken };
