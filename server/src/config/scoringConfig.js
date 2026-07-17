// config/scoringConfig.js - every tunable number the Intelligence
// Engine uses. No scorer module hardcodes a weight, threshold, or
// tier boundary - they all read from here, so the engine can be
// retuned without touching scoring logic.
//
// CORE PHILOSOPHY (see server/INTELLIGENCE_ENGINE.md for the full
// writeup): CRAB is a participant-intelligence platform, not a
// chart-analysis tool. PARTICIPANT SCORE (who is accumulating, who
// is distributing, who is involved) is the primary driver of
// BUY/HOLD/AVOID. MARKET HEALTH (liquidity, security, holder
// distribution, volume, price stability) only confirms or adjusts
// confidence/risk - it can never on its own turn a weak participant
// signal into a BUY, and it can veto to AVOID on a hard safety
// failure (honeypot, critical illiquidity) regardless of how strong
// the participant signal looks.

module.exports = {

    // =====================================
    // PARTICIPANT SCORE (0-100) - the primary driver of action.
    // Weights must sum to participant.maxTotal.
    // =====================================

    participant: {

        maxTotal: 100,

        weights: {

            accumulation: 20,        // net buy/sell flow (trenches.net_buy_24h)
            smartMoney: 18,          // real smart-money trade feed for this token
            kol: 12,                 // real KOL trade feed for this token
            whale: 10,               // concentration of smart/degen wallets among holders
            developer: 10,           // creator track record
            sniperQuality: 8,        // inverse of sniper concentration (high snipers = risk)
            bundleQuality: 7,        // inverse of bundled/coordinated buying
            insiderQuality: 5,       // inverse of insider hold rate
            walletQuality: 5,        // on-demand wallet stats for participants, when cached
            walletProfitability: 5   // on-demand wallet PNL history, when cached

        },

        // Earliness multiplier: applied ONLY to timing-sensitive
        // sub-scores (accumulation, smartMoney, kol) - never to
        // composition signals (whale/developer/sniper/bundle/
        // insider/walletQuality), which are about WHO is involved,
        // not WHEN. A real accumulation signal on a token that
        // hasn't moved yet is worth full credit; the identical
        // signal on a token that already ran 300% is discounted,
        // because it's far more likely to be late FOMO than genuine
        // early conviction - see "NO FABRICATION" and "EARLY
        // DETECTION" principles in the philosophy doc.
        //
        // Keyed by price_change_1h upper bound (%); first matching
        // bucket wins.

        earlinessCurve: [

            { maxChange1h: 10,  factor: 1.00 },
            { maxChange1h: 50,  factor: 0.85 },
            { maxChange1h: 100, factor: 0.60 },
            { maxChange1h: 200, factor: 0.35 },
            { maxChange1h: 300, factor: 0.20 },
            { maxChange1h: Infinity, factor: 0.10 }

        ],

        // Neutral (no-data) score for each sub-category, as a
        // fraction of that category's weight - used when the
        // underlying real data simply doesn't exist yet (never
        // fabricated, never zero-by-default, never full marks by
        // default).

        neutralFraction: 0.4,

        // Minimum total USD volume (buy+sell combined) before a
        // smart-money/KOL/accumulation signal is trusted at full
        // strength. Below this, the module still uses the real data
        // (it's not "no data") but blends the direction-based score
        // toward neutral in proportion to how far short of the
        // threshold the sample is - a 3-trade, $55 "100% buy" sample
        // is real, but it is not the same strength of evidence as a
        // $50,000 one, and scoring it identically was a real flaw
        // found during this sprint's live-data validation (see
        // INTELLIGENCE_ENGINE.md).

        minSignificantVolumeUsd: {

            smartMoney: 300,
            kol: 150,
            accumulation: 500

        }

    },

    // =====================================
    // MARKET HEALTH (0-100) - confirms/adjusts confidence and risk.
    // Never the primary reason for BUY. Weights must sum to
    // market.maxTotal.
    // =====================================

    market: {

        maxTotal: 100,

        weights: {

            liquidity: 30,
            security: 30,
            holderDistribution: 15,
            volume: 10,
            priceStability: 15

        },

        neutralFraction: 0.4,

        // priceStability scoring: a token that has already moved a
        // lot is inherently less "stable" (more reversal/exhaustion
        // risk) regardless of direction - this is the Market-side
        // counterpart to the earliness curve above, reinforcing (not
        // duplicating) the same "prefer early over late" philosophy
        // from a volatility-risk angle instead of a
        // participant-credit angle.

        priceStabilityCurve: [

            { maxAbsChange1h: 10,  factor: 1.00 },
            { maxAbsChange1h: 30,  factor: 0.80 },
            { maxAbsChange1h: 75,  factor: 0.55 },
            { maxAbsChange1h: 150, factor: 0.30 },
            { maxAbsChange1h: 300, factor: 0.15 },
            { maxAbsChange1h: Infinity, factor: 0.05 }

        ]

    },

    // =====================================
    // ACTION TIERS - driven by PARTICIPANT SCORE alone (see
    // safetyVeto below for the one exception: Market Health can
    // downgrade to AVOID on a hard safety failure, but can never
    // upgrade a weak participant score into a BUY).
    // =====================================

    actionTiers: {

        strongBuy: 70,
        buy: 50,
        hold: 30
        // below hold => AVOID

    },

    // Hard safety veto - Market Health facts that force AVOID
    // regardless of Participant Score. This is the ONLY way market
    // data can override participant-driven action, and only ever
    // downward.

    safetyVeto: {

        isHoneypot: true,
        minLiquidityUsd: 2000,
        minBackingRatio: 0.01,
        minHolders: 15

    },

    // =====================================
    // CONFIDENCE - blends both systems. Weighted toward Participant
    // Score (it's the primary signal) but genuinely requires BOTH to
    // be strong for high confidence - a mismatch between the two
    // pulls confidence down even when action itself doesn't change.
    // =====================================

    confidence: {

        participantWeight: 0.6,

        marketWeight: 0.4,

        // Extra penalty applied when the two systems disagree
        // sharply (e.g. participant 90 / market 35) - without this,
        // a weighted average alone would understate how much a
        // mismatch should matter.

        mismatchPenaltyPerPoint: 0.15,

        // Applied on top of the blend when few of the 15 total
        // sub-modules (10 participant + 5 market) have real data -
        // e.g. a token found only via a bare smart-money match, with
        // nothing else collected yet, should never report the same
        // confidence as one corroborated across most modules, even
        // if the few signals it does have look strong.

        maxCompletenessPenalty: 25,

        min: 15,

        max: 99

    },

    // =====================================
    // RISK - counts real risk flags raised by any module (both
    // systems contribute) plus hard triggers.
    // =====================================

    risk: {

        mediumAtRiskReasonCount: 1,

        highAtRiskReasonCount: 4

    },

    // =====================================
    // STAGE - the categorical EARLY/MID/LATE label surfaced on every
    // recommendation. Not a new signal - it's the same
    // price_change_1h-based lateness measurement already driving the
    // participant earliness curve and the market priceStability
    // curve above, just exposed as a human-readable field instead of
    // staying an internal multiplier.
    // =====================================

    stage: {

        earlyMaxAbsChange1h: 15,

        midMaxAbsChange1h: 100

        // above midMaxAbsChange1h => LATE

    }

};
