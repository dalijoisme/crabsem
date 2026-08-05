// config/executionSafetyConfig.js - every tunable number
// services/execution/gmgnSwapTransactionBuilder.js's SELL execution path
// uses. Same "config owns the numbers, service owns the logic"
// convention every other config file in this codebase already
// establishes (scoringConfig.js, exitSystemConfig.js, momentumHealthConfig.js).
//
// Release Validation project, checklist item 9 ("move every production
// tuning value into configuration if currently hardcoded") - these
// values were previously inline constants inside
// gmgnSwapTransactionBuilder.js itself. Moved here verbatim, same
// numbers, same reasoning - see the Execution Safety Project's own
// history for why these specific values were chosen:
//   - tier 1 (15%) is 3x executionGuard.js's own BUY-side default
//     price-impact ceiling (DEFAULT_MAX_PRICE_IMPACT_PCT) - wider
//     because a SELL's risk is already owned, but still real, not
//     unlimited.
//   - tier 2 (50%) is the same tolerance every SELL used unconditionally
//     before the Execution Safety Project - kept as the final real tier
//     rather than reinvented.
//   - beyond both tiers: unconditional acceptance (unchanged from
//     before the Execution Safety Project) - a genuine, sustained
//     collapse must never leave a position permanently stuck.

module.exports = {

    // Bounded, escalating SELL tolerance - never a single fixed
    // ceiling, never an unbounded retry. Tried in order; the first tier
    // whose real price-impact ceiling the quote clears is used.
    exitToleranceTiers: [
        { slippagePct: 15, maxPriceImpactPct: 15 },
        { slippagePct: 50, maxPriceImpactPct: 50 }
    ],

    // BUY's own default request tolerance - unchanged from before the
    // Execution Safety Project, still governed by executionGuard's own
    // guardLimits, never tiered.
    buyDefaultSlippagePct: 10

};
