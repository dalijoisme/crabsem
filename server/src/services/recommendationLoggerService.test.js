// services/recommendationLoggerService.test.js - proves
// logRecommendations' rewrite from a full, unbounded gmgn_tokens scan
// to a freshness-scoped one (RATE_LIMIT_BANNED incident follow-up,
// 2026-08-06 - see that function's own header for the real production
// numbers this closes: analyzeTokens() alone measured 9734ms on an
// ordinary cycle, ballooning past 146-174s under worse conditions).
// The critical property under test: a token the collector hasn't
// touched in 6+ hours never gets logged, while a fresh one still does -
// this is a scope reduction with a real, deliberate behavior change
// (documented and accepted in the function's own header), not a
// query-shape-only optimization. Uses the real intelligenceEngine (not
// mocked), same convention as predictionValidationService.test.js's own
// scoreTokensInBatches tests. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const recommendationLogRepository = require("../repositories/recommendationLogRepository");
const db = require("../database/connection");

const { logRecommendations } = require("./recommendationLoggerService");

const PREFIX = "RECLOGSVC_TEST_";

function upsertTestToken(tokenAddress, overrides = {}){
    gmgnTokenRepository.upsertToken({
        tokenAddress, symbol: "TST", name: "Test Token", chain: "sol", logo: null,
        marketCap: 1000, liquidity: 500, price: 0.001,
        priceChange5m: 0, priceChange1h: 0, priceChange24h: 0,
        volume5m: 0, volume1h: 100, volume24h: 100,
        buys5m: 0, sells5m: 0, holders: 10, fdv: 1000,
        launchTimestamp: Math.floor(Date.now() / 1000), rawJson: "{}",
        ...overrides
    });
}

function backdateToken(tokenAddress, secondsAgo){
    db.prepare("UPDATE gmgn_tokens SET updated_at = datetime('now', '-' || ? || ' seconds') WHERE token_address = ?").run(secondsAgo, tokenAddress);
}

function cleanupTokens(tokenAddresses){
    for(const addr of tokenAddresses){
        db.prepare("DELETE FROM gmgn_tokens WHERE token_address = ?").run(addr);
        db.prepare("DELETE FROM recommendation_log WHERE token_address = ?").run(addr);
    }
}

test("logRecommendations logs a fresh token but skips one the collector hasn't touched in 6+ hours", async () => {

    const freshAddress = `${PREFIX}FRESH`;
    const staleAddress = `${PREFIX}STALE`;

    try{

        upsertTestToken(freshAddress); // fresh - default updated_at is "now"
        upsertTestToken(staleAddress);
        backdateToken(staleAddress, 8 * 60 * 60); // 8 hours ago - past the 6h window

        await logRecommendations();

        assert.ok(
            recommendationLogRepository.findRecentByToken(freshAddress, 5).length >= 1,
            "a freshly-updated token must still get a recommendation logged"
        );
        assert.equal(
            recommendationLogRepository.findRecentByToken(staleAddress, 5).length, 0,
            "a token the collector abandoned 8 hours ago must not be logged - it can't be a real live candidate"
        );

    }
    finally{
        cleanupTokens([freshAddress, staleAddress]);
    }

});
