// services/confidenceDecayService.js - Recommendation Lifecycle sprint.
//
// The homepage/trending surface used to show whatever intelligenceEngine
// computed fresh from raw token data on every request, with NO memory of
// "when was this last actually confirmed by the active engine". That is
// how a token could rug and still sit at #1: nothing measured HOW LONG
// its last real, engine-backed decision had gone unconfirmed.
//
// This module answers exactly that, from one real timestamp already
// written by predictionValidationService.js every cycle:
// token_last_decision.last_decision_at. Confidence decays away from its
// last real value the longer it goes WITHOUT a fresh reconfirmation
// (a new trigger-worthy decision row); the moment the engine reconfirms
// the token (trigger fires again), last_decision_at resets to now and
// confidence is restored to that reconfirmation's real value - never a
// fabricated number, always a fraction of the last real one.

// Anchor points from the approved decay curve. Piecewise-linear between
// anchors (never a step function - a token doesn't lose 5% instantly at
// the 30-minute mark, it erodes continuously).
const CURVE = [
    { minutes: 0, pct: 100 },
    { minutes: 15, pct: 100 },
    { minutes: 30, pct: 95 },
    { minutes: 60, pct: 90 },
    { minutes: 180, pct: 70 },
    { minutes: 360, pct: 50 },
    { minutes: 720, pct: 25 },
    { minutes: 1440, pct: 0 }
];

// Fraction (0..1) of the original confidence still "trusted" after
// `minutesElapsed` without reconfirmation. Clamped to 0 beyond the last
// anchor (24h) - an unconfirmed signal that old carries no weight.
function decayFraction(minutesElapsed){

    if(minutesElapsed <= 0) return 1;

    if(minutesElapsed >= CURVE[CURVE.length - 1].minutes) return 0;

    for(let i = 1; i < CURVE.length; i++){

        const prev = CURVE[i - 1];
        const next = CURVE[i];

        if(minutesElapsed <= next.minutes){

            const span = next.minutes - prev.minutes;
            const progress = span === 0 ? 1 : (minutesElapsed - prev.minutes) / span;

            const pct = prev.pct + (next.pct - prev.pct) * progress;

            return pct / 100;

        }

    }

    return 0;

}

function minutesSince(sqliteTimestamp){

    const then = new Date(`${String(sqliteTimestamp).replace(" ", "T")}Z`).getTime();

    return Math.max(0, (Date.now() - then) / 60000);

}

// baseConfidence: the real confidence recorded at last_decision_at (the
// last time the active engine actually reconfirmed this token).
// Returns a whole-number, decayed confidence - never negative, never
// above the original.
function applyDecay(baseConfidence, lastDecisionAtSqliteTs){

    if(baseConfidence == null || lastDecisionAtSqliteTs == null) return baseConfidence;

    const elapsed = minutesSince(lastDecisionAtSqliteTs);

    const fraction = decayFraction(elapsed);

    return Math.round(Math.max(0, Math.min(baseConfidence, baseConfidence * fraction)));

}

module.exports = { CURVE, decayFraction, minutesSince, applyDecay };
