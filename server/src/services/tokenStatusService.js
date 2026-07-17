// services/tokenStatusService.js - the richer token lifecycle label
// (Trending/Inactive/Dead/Dumped/Completed), built on real signals
// already available: the engine's ACTIVE/WATCHLIST/ARCHIVED lifecycle
// (row age - see intelligenceEngine.js), gmgn_trenches.section (GMGN's
// own real "completed" bonding-curve status), and a real price
// drawdown from the peak this platform has actually observed (see
// tokenPriceHistoryRepository.findPeakPrice).
//
// "Removed" and "Migrated" are deliberately NOT modeled here - GMGN's
// API gives no real "removed" event, and nothing distinguishes a
// genuine on-chain migration from the same "completed" bonding-curve
// signal already covered by Completed. Forcing those two labels in
// without real backing data would mean guessing, which this platform
// does not do (see the "never fabricate" rule).
//
// A token is NEVER deleted from gmgn_tokens regardless of status -
// this is a read-time label, not a lifecycle that removes rows.

const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");

const DEAD_AFTER_SECONDS = 7 * 24 * 60 * 60;

const DUMPED_DRAWDOWN_THRESHOLD = 0.85;

function computeTokenStatus({ token, trenchesEntry, lifecycle, marketAgeSeconds }){

    if(lifecycle === "ACTIVE") return "Trending";

    if(trenchesEntry?.section === "completed") return "Completed";

    if(lifecycle === "ARCHIVED"){

        const peak = tokenPriceHistoryRepository.findPeakPrice(token.token_address);

        if(peak != null && peak > 0 && token.price != null){

            const drawdown = (peak - Number(token.price)) / peak;

            if(drawdown >= DUMPED_DRAWDOWN_THRESHOLD) return "Dumped";

        }

        if(marketAgeSeconds != null && marketAgeSeconds >= DEAD_AFTER_SECONDS) return "Dead";

        return "Inactive";

    }

    // WATCHLIST or UNKNOWN
    return "Inactive";

}

module.exports = { computeTokenStatus };
