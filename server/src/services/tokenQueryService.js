// services/tokenQueryService.js - orchestration between controllers
// and gmgnTokenRepository for every token-listing endpoint. No SQL
// here - only repository calls, the Intelligence Engine, and
// response shaping.

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const intelligenceEngine = require("./intelligenceEngine");

// Attaches a real, freshly-computed signal to a token row. Computed
// at read time (not stored) so it never goes stale against an old
// row - every call reads whatever is currently in SQLite across
// every collected source (see intelligenceEngine.js).

function withSignal(token){

    return { ...token, signal: intelligenceEngine.analyzeToken(token) };

}

// List-mode version of withSignal - one batched preload for the
// whole page (see intelligenceEngine.analyzeTokens) instead of each
// row triggering its own ~8-16 queries. Same per-row shape as
// tokens.map(withSignal).

function attachSignals(tokens){

    const signals = intelligenceEngine.analyzeTokens(tokens);

    return tokens.map((token, i) => ({ ...token, signal: signals[i] }));

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

function getTokenByAddress(address){

    const token = gmgnTokenRepository.getTokenByAddress(address);

    return token ? withSignal(token) : null;

}

// Recommendation-quality order: STRONG BUY > BUY > HOLD > AVOID,
// then within each tier the strongest, most trustworthy, freshest
// evidence first. Archived tokens (data too old to trust - see
// intelligenceEngine's freshness/lifecycle) are excluded entirely
// from the default trending list rather than shown as if they were
// live recommendations; they remain reachable via search/detail with
// their staleness clearly labeled.

const ACTION_RANK = { "STRONG BUY": 0, "BUY": 1, "HOLD": 2, "AVOID": 3 };

function rankRecommendations(tokensWithSignal){

    return tokensWithSignal

        .filter(t => t.signal.lifecycle !== "ARCHIVED")

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

    const candidates = gmgnTokenRepository.findMany({

        limit: Math.min(limit * 4, 400),

        offset: 0,

        sortColumn: "volume_1h",

        direction: "DESC",

        search: null

    });

    const ranked = rankRecommendations(attachSignals(candidates));

    return { tokens: ranked.slice(0, limit) };

}

function search(query, limit){

    const tokens = gmgnTokenRepository.findMany({

        limit,

        offset: 0,

        sortColumn: "market_cap",

        direction: "DESC",

        search: query

    });

    return { query, tokens: attachSignals(tokens) };

}

module.exports = { listTokens, getTokenByAddress, getTrending, search };
