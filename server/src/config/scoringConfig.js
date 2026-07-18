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

    // Evidence-based adjustment (usability-testing sprint): the
    // validation framework's real recommendation_outcomes data (4,149
    // resolved outcomes across 15m/30m/1h/4h at the time of this
    // change) showed BUY-tier accuracy consistently at 40-49% -
    // worse than a coin flip - at every horizon, while HOLD (81-84%)
    // and AVOID (59-71%) were reliable. Raising the BUY floor from 50
    // to 55 moved the weakest, most error-prone participant scores
    // into HOLD instead, where the real track record is far better.
    //
    // FURTHER RAISED (engine-quality sprint): user-reported cases of
    // STRONG BUY at participant score ~90 on tokens that were visibly
    // dumping exposed a real bug (see accumulation/smartMoney/kol.js -
    // the earliness curve was keyed on signed change1h, not magnitude,
    // so a crashing token wrongly kept full "early" credit) plus a
    // real architectural gap (market structure - real price trend -
    // could weaken confidence but never block a BUY-tier action; see
    // structuralValidation below, which now closes that gap). With
    // both of those fixed, thresholds are raised again as a deliberate
    // policy tightening, not a new data-validated number - STRONG BUY
    // must be rare and require genuinely exceptional evidence, BUY
    // must require a real, meaningfully-above-average score, and HOLD
    // is the honest default when evidence is merely "fine". This
    // should be re-checked against fresh recommendation_outcomes data
    // once enough volume accumulates at the new tiers.

    actionTiers: {

        strongBuy: 80,
        buy: 62,
        hold: 35
        // below hold => AVOID

    },

    // =====================================
    // STRUCTURAL SELF-VALIDATION (engine-quality sprint) - the
    // "market structure contradicts the recommendation -> downgrade"
    // gate. Participant Score stays the primary driver of action (see
    // philosophy note at the top of this file), but a STRONG BUY/BUY
    // that real, already-collected price-trend/flow evidence directly
    // contradicts must never reach the user un-downgraded - that is
    // exactly the "score 90, chart clearly falling" failure mode this
    // sprint exists to close. This is deliberately separate from
    // safetyVeto below: safetyVeto is a hard, absolute override to
    // AVOID on a handful of binary safety facts; this is a graduated,
    // evidence-counted downgrade (by one or two tiers) that only ever
    // fires on BUY-tier actions and is always reported back
    // (signal.selfValidation) so a downgrade is auditable, never a
    // silent guess.
    //
    // Every flag below reads a real field the engine already has for
    // this exact call (price_change_1h/5m, gmgn_trenches.net_buy_24h,
    // the already-computed smartMoney/kol participant sub-scores, and
    // a real historical peak price from token_price_history) - nothing
    // here is estimated or fabricated, and every flag is skipped
    // (never counted for or against) when its underlying data isn't
    // real for this token.

    structuralValidation: {

        // A "real" downtrend over the last hour worth counting as a
        // red flag.
        downtrend1hPct: -10,

        // A sharp move in just the last 5 minutes - "a recent dump in
        // progress" - counted regardless of the 1h figure, since a
        // token can be flat-to-up over 1h and still be actively
        // dumping right now.
        recentDump5mPct: -8,

        // Real drawdown from the highest price this platform has ever
        // actually observed for this token (token_price_history) -
        // this is a genuine "the structure has broken down" signal,
        // not a guess about swing highs/lows we don't have candle
        // data to compute.
        structuralBreakdownDrawdown: 0.5,

        // Net-flow confirmation: gmgn_trenches.net_buy_24h already
        // real and already used by accumulation.js - re-used here as
        // corroborating structural evidence when clearly negative.
        netDistributionUsd: -500,

        // A participant sub-score is only counted as "distributing"
        // corroboration when it has real data AND sits at/below this
        // fraction of its own max (matches the <=0.15-ish floor
        // smartMoney.js/kol.js already assign to real distribution).
        distributingSubScoreFraction: 0.25,

        // Tier downgrade steps applied once redFlags reaches these
        // counts - STRONG BUY needs only one real red flag to lose its
        // "strong" status (it is meant to be rare and clean); BUY
        // tolerates one, but two real contradicting signals means the
        // evidence genuinely disagrees with a buy-tier action.
        downgradeAfter: {

            strongBuyToBuy: 1,
            strongBuyToHold: 2,
            buyToHold: 2

        }

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

    },

    // =====================================
    // FRESHNESS / LIFECYCLE - how old is the data a recommendation is
    // actually computed from. `market` age is the token's own
    // gmgn_tokens row (price/liquidity/market cap/volume/holders) -
    // the fastest-moving, most important category. A token whose row
    // hasn't been touched recently has simply fallen out of GMGN's
    // trending top-N (see server/data-integrity audit); it is not
    // deleted, so without this it would keep being scored and shown
    // as if it were live.
    // =====================================

    freshness: {

        lifecycle: {

            // <= this age (seconds): still being refreshed every
            // scheduler tick.
            activeMaxAgeSeconds: 5 * 60,

            // <= this age: dropped out of the live scan, but recent
            // enough to keep showing (clearly labeled) rather than
            // hide outright.
            watchlistMaxAgeSeconds: 60 * 60

            // older than watchlistMaxAgeSeconds => ARCHIVED

        },

        // Confidence penalty for stale market data - 0 at 0s old,
        // ramping linearly to maxPenalty at fullPenaltyAfterSeconds
        // and beyond. This is separate from (and in addition to) the
        // existing completeness penalty, which measures whether data
        // exists at all, not how old it is.

        confidencePenalty: {

            maxPenalty: 20,

            fullPenaltyAfterSeconds: 60 * 60

        }

    }

};
