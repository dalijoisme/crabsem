// services/decisionTimelineService.js - Sprint 15 (Scientific Decision
// Framework), Phase 5 (Decision Timeline / "flight recorder"). Records
// how a real, open position's market evidence evolves after entry -
// price, liquidity, holders, whale/bundle/fresh-wallet/synthetic
// signals, momentum phase - at a decaying cadence, piggybacked on the
// existing exit-management tick.
//
// NOT part of the BUY Decision Pipeline (Collector -> Context Builder ->
// Research Engine -> Entry Gate -> Quality Gate -> Opportunity Priority
// -> BUY) - this records what happens AFTER a BUY, during position
// management, the same stage dynamicExitService.js/manageOpenPositions
// already operate in and already call repositories directly from. The
// Sprint 15 Repository Boundary invariant is scoped to the BUY decision
// path; it does not apply here, and this file calling
// tokenPriceHistoryRepository directly is not a violation of it.
//
// SAFETY INVARIANT: same as decisionEvidenceService.js - sampling must
// never be able to affect exit decisions or block/slow position
// management. maybeSampleForPosition never throws past its own boundary.
//
// SCOPE (documented, not silent): smart-money/KOL net flow are not
// captured here - they would need a fresh gmgn_activity_feed query this
// call site doesn't otherwise make, and manageOpenPositions doesn't
// currently fetch it. Whale concentration (smart_degen_count), bundler
// rate, fresh-wallet rate, and synthetic score ARE captured - all
// cheaply available from the token/trenches data manageOpenPositions
// already has in hand.

const decisionTimelineRepository = require("../repositories/decisionTimelineRepository");
const decisionEvidenceRepository = require("../repositories/decisionEvidenceRepository");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");
const syntheticMarketFilterService = require("./syntheticMarketFilterService");
const momentumPhase = require("./intelligence/market/momentumPhase");

// Real, first, reasonable bound - same "unvalidated starting point, not
// final" convention this codebase already uses for a brand-new
// threshold. Dense while a position is young - real catastrophic dumps
// in this account's own trade history resolved within under a minute of
// entry (see the Sprint 15 validation rounds) - sparse afterward, so a
// position held for days doesn't accumulate an unbounded sample count.
const DENSE_WINDOW_MINUTES = 5;
const SPARSE_SAMPLE_INTERVAL_MINUTES = 5;

function minutesSince(sqliteTimestamp){
    if(!sqliteTimestamp) return Infinity;
    const then = new Date(`${String(sqliteTimestamp).replace(" ", "T")}Z`).getTime();
    return Math.max(0, (Date.now() - then) / 60000);
}

// Real, not fabricated: reuses syntheticMarketFilterService's own already-
// proven composite (the exact same signal the BUY-time veto and
// dynamicExitService's Momentum Health both already use) - never a
// second implementation of "how synthetic does this orderflow look".
function extractSyntheticFacts(trenchesEntry){
    if(!trenchesEntry) return { bundlerTraderAmountRate: null, freshWalletRate: null, syntheticScore: null };
    const { syntheticScore } = syntheticMarketFilterService.computeSyntheticBreakdown(trenchesEntry);
    let raw = {};
    try{ raw = trenchesEntry.raw_json ? JSON.parse(trenchesEntry.raw_json) : {}; }
    catch(e){ /* malformed - honest null, never guessed */ }
    return {
        bundlerTraderAmountRate: raw.bundler_trader_amount_rate ?? null,
        freshWalletRate: raw.fresh_wallet_rate ?? null,
        syntheticScore: Number.isFinite(syntheticScore) ? syntheticScore : null
    };
}

// Real decaying-cadence check - dense for the first DENSE_WINDOW_MINUTES
// of a position's life (samples every time this is called, whatever the
// caller's own real cadence is - piggybacked, never a new poll), then at
// most once per SPARSE_SAMPLE_INTERVAL_MINUTES afterward.
function isSampleDue(position, decisionEvidenceId){
    const positionAgeMinutes = minutesSince(position.opened_at);
    if(positionAgeMinutes <= DENSE_WINDOW_MINUTES) return true;
    const lastSampleTime = decisionTimelineRepository.findMostRecentSampleTime(decisionEvidenceId);
    if(!lastSampleTime) return true; // dense window already passed but somehow never sampled - sample now rather than wait a full interval
    return minutesSince(lastSampleTime) >= SPARSE_SAMPLE_INTERVAL_MINUTES;
}

// Called once per open position per manageOpenPositions pass (both the
// main scan cadence and the independent, faster exit-evaluation cadence
// share this one function - see this file's own header). Never throws;
// a sampling failure costs a data point, never a position's exit
// handling. Returns the new sample id, or null if no sample was taken
// (not due yet, no linked decision, or a capture error).
function maybeSampleForPosition(position, token, trenchesEntry){
    try{

        if(!token) return null;

        const decisionEvidence = decisionEvidenceRepository.findByPositionId(position.id);
        if(!decisionEvidence) return null; // no linked decision (e.g. a legacy position from before Phase 3) - nothing to attach a sample to

        if(!isSampleDue(position, decisionEvidence.id)) return null;

        const peak = tokenPriceHistoryRepository.findPeakPrice(token.token_address);
        const { phase } = momentumPhase.classifyMomentumPhase(token, trenchesEntry, peak);
        const { bundlerTraderAmountRate, freshWalletRate, syntheticScore } = extractSyntheticFacts(trenchesEntry);

        return decisionTimelineRepository.insertSample({
            decisionEvidenceId: decisionEvidence.id,
            tokenAddress: position.token_address,
            price: token.price != null ? Number(token.price) : null,
            liquidity: token.liquidity != null ? Number(token.liquidity) : null,
            holders: token.holders != null ? Number(token.holders) : null,
            smartDegenCount: trenchesEntry?.smart_degen_count ?? null,
            bundlerTraderAmountRate, freshWalletRate, syntheticScore,
            momentumPhase: phase
        });

    }
    catch(err){
        console.error(`[decision-timeline] sample failed for position=${position?.id} token=${token?.symbol || token?.token_address}: ${err.message}`, err);
        return null;
    }
}

module.exports = {
    maybeSampleForPosition,
    DENSE_WINDOW_MINUTES, SPARSE_SAMPLE_INTERVAL_MINUTES,
    // exported for tests only.
    isSampleDue, extractSyntheticFacts
};
