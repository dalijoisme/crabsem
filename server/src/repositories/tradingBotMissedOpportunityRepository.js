// repositories/tradingBotMissedOpportunityRepository.js - Momentum
// Validation System sprint (Sprint 5), this sprint's own stated top
// priority. Real history of "token was seen, genuinely rejected by the
// frozen entry gate, and later did X" - never a guessed reason, never a
// fabricated outcome.
//
// The partial unique index (migration 053) bounds this table to exactly
// one PENDING row per (user, token): a token rejected every cycle for
// hours refreshes the same row instead of inserting one row per cycle.
// Once outcome_evaluated_at is set, a later fresh rejection of the same
// token opens a genuinely new row.

const db = require("../database/connection");

const upsertPendingStmt = db.prepare(`
    INSERT INTO trading_bot_missed_opportunity (user_id, token_address, token_symbol, rank_at_skip, priority_score_at_skip, reason, price_at_skip, skipped_at)
    VALUES (@userId, @tokenAddress, @tokenSymbol, @rankAtSkip, @priorityScoreAtSkip, @reason, @priceAtSkip, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, token_address) WHERE outcome_evaluated_at IS NULL
    DO UPDATE SET rank_at_skip = excluded.rank_at_skip, priority_score_at_skip = excluded.priority_score_at_skip,
                  reason = excluded.reason, price_at_skip = excluded.price_at_skip
`);

// Called once per real BUY-tier rejection - bounded by the same small
// qualified-candidate count tradingBotEngine.js's decision-snapshot
// already uses, never by the full scan universe. skipped_at is only ever
// set on the FIRST rejection of a still-pending row (the INSERT branch) -
// a refreshed rejection never resets it, so it stays "when we first
// missed this one this time."
function upsertPending(userId, { tokenAddress, tokenSymbol, rankAtSkip, priorityScoreAtSkip, reason, priceAtSkip }){
    upsertPendingStmt.run({
        userId, tokenAddress, tokenSymbol: tokenSymbol ?? null,
        rankAtSkip: rankAtSkip ?? null, priorityScoreAtSkip: priorityScoreAtSkip ?? null,
        reason, priceAtSkip: priceAtSkip ?? null
    });
}

// Pending rows whose skip is older than the given horizon - the real
// candidates for the outcome-filling scheduler to evaluate this tick.
function findPendingOlderThan(horizonHours){
    return db.prepare(`
        SELECT * FROM trading_bot_missed_opportunity
        WHERE outcome_evaluated_at IS NULL AND datetime(skipped_at) <= datetime('now', '-' || ? || ' hours')
    `).all(horizonHours);
}

const fillOutcomeStmt = db.prepare(`
    UPDATE trading_bot_missed_opportunity
    SET outcome_price = @outcomePrice, outcome_return_pct = @outcomeReturnPct, outcome_evaluated_at = CURRENT_TIMESTAMP
    WHERE id = @id
`);

function fillOutcome(id, { outcomePrice, outcomeReturnPct }){
    fillOutcomeStmt.run({ id, outcomePrice: outcomePrice ?? null, outcomeReturnPct: outcomeReturnPct ?? null });
}

// Missed Winners page - real, evaluated outcomes only, best performers
// first. Never includes a still-pending (outcome unknown) row - "Hasil
// Akhir" must be a real, settled number.
function findEvaluated(userId, limit){
    return db.prepare(`
        SELECT * FROM trading_bot_missed_opportunity
        WHERE user_id = ? AND outcome_evaluated_at IS NOT NULL
        ORDER BY outcome_return_pct DESC
        LIMIT ?
    `).all(userId, limit || 50);
}

// Phase 2 (Live Validation & Bottleneck Elimination): real Missed Winner
// count for "dalam 1 jam" - real evaluated outcomes only (pending rows
// never counted, since a real number isn't known yet either way).
function countEvaluatedSince(userId, hours){
    return db.prepare(`
        SELECT COUNT(*) as c FROM trading_bot_missed_opportunity
        WHERE user_id = ? AND outcome_evaluated_at IS NOT NULL AND datetime(skipped_at) >= datetime('now', '-' || ? || ' hours')
    `).get(userId, hours).c;
}

// Bottleneck Report: every real miss (pending OR evaluated - a
// bottleneck cause is real the moment it's recorded, it doesn't need to
// wait for the later outcome) within a rolling window.
function findAllSince(userId, hours){
    return db.prepare(`
        SELECT * FROM trading_bot_missed_opportunity
        WHERE user_id = ? AND datetime(skipped_at) >= datetime('now', '-' || ? || ' hours')
    `).all(userId, hours);
}

module.exports = { upsertPending, findPendingOlderThan, fillOutcome, findEvaluated, countEvaluatedSince, findAllSince };
