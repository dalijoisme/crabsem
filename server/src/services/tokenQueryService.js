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

        tokens: tokens.map(withSignal),

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

function getTrending(limit){

    const tokens = gmgnTokenRepository.findMany({

        limit,

        offset: 0,

        sortColumn: "volume_1h",

        direction: "DESC",

        search: null

    });

    return { tokens: tokens.map(withSignal) };

}

function search(query, limit){

    const tokens = gmgnTokenRepository.findMany({

        limit,

        offset: 0,

        sortColumn: "market_cap",

        direction: "DESC",

        search: query

    });

    return { query, tokens: tokens.map(withSignal) };

}

module.exports = { listTokens, getTokenByAddress, getTrending, search };
