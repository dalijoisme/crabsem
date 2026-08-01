// config/momentumHealthConfig.js - Arjuna vNext sprint, Priority 2/3
// (Exit Intelligence / Profit Protection). Same "config owns the
// numbers, service owns the logic" convention as scoringConfig.js /
// decisionEngineV2Config.js / syntheticMarketFilterConfig.js.
//
// Every input the Momentum Health Score (services/dynamicExitService.js)
// uses is already passed into evaluateDynamicExit() today (token,
// position, trenchesEntry) - nothing new is fetched from GMGN for this,
// and services/tradeManager.js's own call site is never touched, so the
// existing real-time exit scheduler wiring is completely unaffected.

module.exports = {

    // Weighted composite (0-100, higher = healthier) - must sum to 1.
    weights: {
        priceAcceleration: 0.20,   // is the 5m move keeping pace with the 1h trend, or fading
        buyerPressure: 0.15,       // buys_5m vs sells_5m - fresher than trenches' 24h window
        volumeTrend: 0.15,         // current volume_1h vs the position's own last reading
        liquidityHealth: 0.15,     // liquidity/market_cap - thin liquidity relative to cap is fragile
        structuralIntegrity: 0.20, // drawdown from real historical peak + 24h net buy/sell
        orderflowIntegrity: 0.15   // inverse of the SAME synthetic/bot score Priority 1 computes at BUY time
    },

    // liquidity/market_cap ratio floor - below this scores 0, at/above
    // scores 100. Deliberately generous (a real, healthy pair can sit
    // well under 10%) - only flags a token whose liquidity has become
    // genuinely thin relative to its own cap, not a strict rug proof.
    liquidityHealthCeiling: 0.05,

    // Below this composite score (and only when the token's market
    // context is NOT stale - never force-close on uncertain data), Exit
    // Intelligence closes immediately regardless of ROI/TP/SL/trailing -
    // "keluar sebelum rug pull, bukan sesudah." Deliberately conservative
    // (multiple signals must be simultaneously bad) so this can only ever
    // ADD an earlier real exit on a genuinely deteriorating position, never
    // turn Arjuna passive on a healthy one still under its TP floor. An
    // unvalidated starting point like every other new threshold in this
    // codebase's history - meant to be re-checked once real close outcomes
    // accumulate.
    hardBreakdownFloor: 25,

    // Only checked once a position has already reached its own minTpPct
    // floor (Profit Protection, Priority 3) - a higher/easier-to-trigger
    // bar than hardBreakdownFloor above, since giving back locked-in
    // profit while waiting for the existing 4-condition momentum-sustained
    // check (or a trailing stop) to catch up is exactly the "profit tinggi
    // -> tunggu trailing -> harga jatuh -> baru jual" pattern this sprint
    // exists to close. Checked BEFORE the existing momentumSustained
    // check, which remains completely unchanged as a fallback.
    profitProtectionDecayFloor: 45

};
