// services/tokenQueryService.js - orchestration between controllers
// and gmgnTokenRepository for every token-listing endpoint. No SQL
// here - only repository calls, the Intelligence Engine, and
// response shaping.

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const intelligenceEngine = require("./intelligenceEngine");
const tradePlanService = require("./tradePlanService");
const globalSearchService = require("./globalSearchService");
const liveRecommendationService = require("./liveRecommendationService");

// Attaches a real signal to a token row: intelligenceEngine still
// supplies the rich breakdown/reasons/intelligence sections (real,
// useful per-module detail, computed fresh every call so it never
// goes stale), but the DECISIVE fields - action, confidence, risk,
// and whether this token belongs on trending at all - now come from
// liveRecommendationService, which overlays the SAME decision-log
// record (token_last_decision) that drives the Decision Timeline,
// decayed by real elapsed time since it was last reconfirmed. This is
// what makes the homepage card and the Timeline agree (see the
// Recommendation Lifecycle redesign report).

function withSignal(token){

    const baseSignal = intelligenceEngine.analyzeToken(token);
    const live = liveRecommendationService.resolveLiveRecommendation(token, baseSignal);

    return {
        ...token,
        signal: {
            ...baseSignal,
            action: live.action,
            confidence: live.confidence,
            risk: live.risk
        },
        liveState: live
    };

}

// List-mode version of withSignal - one batched preload for the
// whole page (see intelligenceEngine.analyzeTokens) instead of each
// row triggering its own ~8-16 queries. Same per-row shape as
// tokens.map(withSignal).

function attachSignals(tokens){

    const signals = intelligenceEngine.analyzeTokens(tokens);

    return tokens.map((token, i) => {

        const baseSignal = signals[i];
        const live = liveRecommendationService.resolveLiveRecommendation(token, baseSignal);

        return {
            ...token,
            signal: { ...baseSignal, action: live.action, confidence: live.confidence, risk: live.risk },
            liveState: live
        };

    });

}

function listTokens({ page, limit, sort, direction, search }){

    const offset = (page - 1) * limit;

    const tokens = gmgnTokenRepository.findMany({

        limit,

        offset,

        sortColumn: sort,

        direction,

        search

    });

    const total = gmgnTokenRepository.countMany({ search });

    return {

        tokens: attachSignals(tokens),

        pagination: {

            page,

            limit,

            total,

            totalPages: Math.max(1, Math.ceil(total / limit))

        }

    };

}

// Only the single-token detail view gets a trade plan (real decision
// history + risk bands) - list/trending/search stay lean since
// building the decision timeline is a per-token query not worth
// paying for across 50+ rows at once.

function getTokenByAddress(address){

    const token = gmgnTokenRepository.getTokenByAddress(address);

    if(!token) return null;

    const withSig = withSignal(token);

    return { ...withSig, tradePlan: tradePlanService.getTradePlan(token, withSig.signal) };

}

// Recommendation-quality order: STRONG BUY > BUY > HOLD > AVOID,
// then within each tier the strongest, most trustworthy, freshest
// evidence first. Archived tokens (data too old to trust - see
// intelligenceEngine's freshness/lifecycle) are excluded entirely
// from the default trending list rather than shown as if they were
// live recommendations; they remain reachable via search/detail with
// their staleness clearly labeled.

const ACTION_RANK = { "STRONG BUY": 0, "BUY": 1, "HOLD": 2, "WATCHLIST": 3, "AVOID": 4 };

// Trending-only hard exclusion (Recommendation Lifecycle redesign,
// Bug #3): a token that fails the Quality Gate, is flagged Dumped/Dead
// by tokenStatusService's real price-drawdown/age facts, or has fully
// decayed with no reconfirmation, is never shown as an active
// recommendation - not just ranked last. It stays fully reachable via
// /tokens and /token/:address (search/detail), same precedent as the
// pre-existing ARCHIVED exclusion below.

function rankRecommendations(tokensWithSignal){

    return tokensWithSignal

        .filter(t => t.signal.lifecycle !== "ARCHIVED" && !t.liveState?.excludeFromTrending)

        .sort((a, b) => {

            const tierDiff = ACTION_RANK[a.signal.action] - ACTION_RANK[b.signal.action];

            if(tierDiff !== 0) return tierDiff;

            if(b.signal.participantScore !== a.signal.participantScore) return b.signal.participantScore - a.signal.participantScore;

            if(b.signal.confidence !== a.signal.confidence) return b.signal.confidence - a.signal.confidence;

            if(b.signal.marketHealth !== a.signal.marketHealth) return b.signal.marketHealth - a.signal.marketHealth;

            return String(b.updated_at).localeCompare(String(a.updated_at));

        });

}

function getTrending(limit){

    // Pull extra headroom before filtering/sorting: archived tokens
    // get excluded and the sort order changes from the raw SQL order,
    // so a straight LIMIT at the DB layer could under-fill the page.
    //
    // ROOT CAUSE FIX (Recommendation Lifecycle redesign, Bug #1): this
    // used to sort the candidate pool by volume_1h DESC. volume_1h is
    // a plain column value, written once per collector tick and then
    // FROZEN the moment a token drops out of the collector's scan (see
    // gmgnTokenRepository upsert) - so "highest volume_1h" was
    // dominated by tokens with a large HISTORICAL spike whose row
    // hadn't been touched in hours, not tokens that are actually live
    // right now. Measured on the real local DB: sorting by volume_1h
    // put 320 of the top 400 candidates (80%) into ARCHIVED lifecycle,
    // starving the real trending list down to ~23 survivors. Sorting
    // by updated_at DESC instead means the candidate pool is built
    // from tokens the collector is CURRENTLY tracking first - exactly
    // "depend on live state, not initial prediction, market freshness"
    // from the bug report - before rankRecommendations even applies
    // its own signal-based ordering.

    const candidates = gmgnTokenRepository.findMany({

        limit: Math.min(limit * 4, 400),

        offset: 0,

        sortColumn: "updated_at",

        direction: "DESC",

        search: null

    });

    const ranked = rankRecommendations(attachSignals(candidates));

    return { tokens: ranked.slice(0, limit) };

}

// GLOBAL SEARCH (Critical Issue #1 - engine-quality sprint): local
// gmgn_tokens cache first, then a real live DexScreener lookup for
// any Solana token that isn't already monitored - see
// globalSearchService.js for the full fallback chain. Async now
// (the local-only path used to be synchronous) since the fallback is
// a real network call - see searchController.js's await.

async function search(query, limit){

    return globalSearchService.search(query, limit);

}

module.exports = { listTokens, getTokenByAddress, getTrending, search };
