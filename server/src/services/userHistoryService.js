// services/userHistoryService.js - Recently Viewed / Watch Later /
// Favorites / Smart Recall. Keyed by the viewer's own connected
// wallet address (the existing wallet.html verification flow already
// establishes this identity - no new account system). Real signal
// snapshots only - Smart Recall's diff is always computed from a
// previously-recorded real view, never an assumption.

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const userTokenViewsRepository = require("../repositories/userTokenViewsRepository");
const userListsRepository = require("../repositories/userListsRepository");
const intelligenceEngine = require("./intelligenceEngine");

// Records a real view and returns a Smart Recall diff against the
// viewer's own previous real view of this exact token, if one exists.

function recordView(viewerWalletAddress, tokenAddress){

    const token = gmgnTokenRepository.getTokenByAddress(tokenAddress);

    if(!token) return { recorded: false, reason: "token not found" };

    const signal = intelligenceEngine.analyzeToken(token);

    const previous = userTokenViewsRepository.findPreviousView(viewerWalletAddress, tokenAddress);

    userTokenViewsRepository.recordView({

        viewerWalletAddress,

        tokenAddress,

        actionAtView: signal.action,

        participantScoreAtView: signal.participantScore,

        confidenceAtView: signal.confidence,

        priceAtView: token.price,

        marketCapAtView: token.market_cap

    });

    if(!previous) return { recorded: true, smartRecall: null };

    const priceChangePct = (previous.price_at_view && token.price != null && previous.price_at_view > 0)

        ? ((token.price - previous.price_at_view) / previous.price_at_view) * 100

        : null;

    return {

        recorded: true,

        smartRecall: {

            previousViewedAt: previous.viewed_at,

            priceChangePct,

            actionChanged: previous.action_at_view !== signal.action,

            previousAction: previous.action_at_view,

            currentAction: signal.action,

            participantScoreDelta: (previous.participant_score_at_view != null)

                ? signal.participantScore - previous.participant_score_at_view

                : null,

            confidenceDelta: (previous.confidence_at_view != null)

                ? signal.confidence - previous.confidence_at_view

                : null

        }

    };

}

// Attaches a real, freshly-computed signal to every row (batched via
// analyzeTokens, not one-by-one), flattened onto the token object
// (`{...token, signal, ...meta}`) so the frontend can render these
// with the exact same UI.renderCard() used for trending/search - no
// separate rendering path needed. A token address with nothing in
// gmgn_tokens (never actually collected at all) is dropped, not
// nulled out - real history about an address CRAB never observed
// isn't renderable as a card.

function attachSignalsToRows(rows, metaKey){

    const addresses = rows.map(r => r.token_address);

    const tokens = addresses.map(a => gmgnTokenRepository.getTokenByAddress(a)).filter(Boolean);

    if(!tokens.length) return [];

    const signals = intelligenceEngine.analyzeTokens(tokens);

    const metaByAddress = new Map(rows.map(r => [r.token_address, r[metaKey]]));

    return tokens.map((token, i) => ({

        ...token,

        signal: signals[i],

        [metaKey]: metaByAddress.get(token.token_address)

    }));

}

function getRecentlyViewed(viewerWalletAddress, limit = 100){

    const rows = userTokenViewsRepository.findRecentDistinct(viewerWalletAddress, limit)

        .map(r => ({ token_address: r.token_address, lastViewedAt: r.last_viewed_at }));

    return attachSignalsToRows(rows, "lastViewedAt");

}

function getWatchlist(viewerWalletAddress){

    const rows = userListsRepository.listWatchlist(viewerWalletAddress)

        .map(r => ({ token_address: r.token_address, addedAt: r.added_at }));

    return attachSignalsToRows(rows, "addedAt");

}

function getFavorites(viewerWalletAddress){

    const rows = userListsRepository.listFavorites(viewerWalletAddress)

        .map(r => ({ token_address: r.token_address, addedAt: r.added_at }));

    return attachSignalsToRows(rows, "addedAt");

}

module.exports = {

    recordView,

    getRecentlyViewed,

    getWatchlist,

    getFavorites,

    addToWatchlist: (v,t) => { userListsRepository.addToWatchlist(v,t); return { inList: true }; },

    removeFromWatchlist: (v,t) => { userListsRepository.removeFromWatchlist(v,t); return { inList: false }; },

    addToFavorites: (v,t) => { userListsRepository.addToFavorites(v,t); return { inList: true }; },

    removeFromFavorites: (v,t) => { userListsRepository.removeFromFavorites(v,t); return { inList: false }; }

};
