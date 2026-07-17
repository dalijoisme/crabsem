// repositories/userTokenViewsRepository.js - append-only per-viewer
// token view log (real signal snapshot at view time). Never deleted -
// this is the real data Smart Recall diffs against.

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO user_token_views (
        viewer_wallet_address, token_address, action_at_view,
        participant_score_at_view, confidence_at_view, price_at_view, market_cap_at_view
    ) VALUES (
        @viewerWalletAddress, @tokenAddress, @actionAtView,
        @participantScoreAtView, @confidenceAtView, @priceAtView, @marketCapAtView
    )
`);

function recordView(entry){

    return insertStmt.run(entry).lastInsertRowid;

}

// Last N DISTINCT tokens a viewer has opened, most-recent first -
// "Recently Viewed". Distinct via a correlated MAX(viewed_at) group.

function findRecentDistinct(viewerWalletAddress, limit = 100){

    return db.prepare(`
        SELECT token_address, MAX(viewed_at) as last_viewed_at
        FROM user_token_views
        WHERE viewer_wallet_address = ?
        GROUP BY token_address
        ORDER BY last_viewed_at DESC
        LIMIT ?
    `).all(viewerWalletAddress, limit);

}

// The most recent EXISTING view for this token, called from
// recordView() BEFORE the new view row is inserted - so "most recent
// existing row" IS "the previous view" at call time, what "Smart
// Recall" diffs the CURRENT signal against.

function findPreviousView(viewerWalletAddress, tokenAddress){

    return db.prepare(`
        SELECT * FROM user_token_views
        WHERE viewer_wallet_address = ? AND token_address = ?
        ORDER BY viewed_at DESC
        LIMIT 1
    `).get(viewerWalletAddress, tokenAddress);

}

function findHistoryForToken(viewerWalletAddress, tokenAddress, limit = 50){

    return db.prepare(`
        SELECT * FROM user_token_views
        WHERE viewer_wallet_address = ? AND token_address = ?
        ORDER BY viewed_at DESC
        LIMIT ?
    `).all(viewerWalletAddress, tokenAddress, limit);

}

module.exports = { recordView, findRecentDistinct, findPreviousView, findHistoryForToken };
