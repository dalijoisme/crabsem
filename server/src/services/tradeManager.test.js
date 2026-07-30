// services/tradeManager.test.js - Trust/UX sprint: proves openPosition()
// persists the real, already-computed decision breakdown (participant/
// market module scores, acceleration, reasons) instead of discarding it -
// the identical "computed then discarded" bug shape already fixed once
// this engagement for ranking. Uses one real token from the local dev
// DB and the real scoring engine (not a synthetic `live` stub) so this
// is a genuine end-to-end proof, not just a serialization unit test.
// Integration-style, same convention as tradingBotService.test.js. Run
// with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const tradeManager = require("./tradeManager");
const tradingBotRepository = require("../repositories/tradingBotRepository");
const userAuthService = require("./userAuthService");
const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const researchEngineFactory = require("./researchEngineFactory");
const strategyProfileConfig = require("../config/strategyProfileConfig");
const strategyProfileTranslator = require("./strategyProfileTranslator");
const db = require("../database/connection");

function deleteTestUser(id){
    db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_trades WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_positions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_log WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_config WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM trading_bot_state WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

test("openPosition persists the real decision breakdown - was discarded before this sprint's fix", async () => {

    const testEmail = `tradermanager.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        // One real token with a real price/market_cap, scored for real
        // under AGGRESSIVE - the exact same signal shape
        // tradingBotScheduler.js's computeLiveByAddressForPhilosophy now
        // carries through (breakdown/reasons/acceleration), not a
        // hand-built fixture.
        const token = gmgnTokenRepository.getAllTokens().find(t => t.market_cap > 0 && t.price > 0);
        assert.ok(token, "local dev DB must have at least one real priced token for this test to mean anything");

        const philosophy = strategyProfileTranslator.translate(strategyProfileConfig.resolveProfile("AGGRESSIVE")).philosophy;
        const ctx = researchEngineFactory.preloadContext([token]);
        const [signal] = researchEngineFactory.analyzeTokensWithOverride([token], ctx, "momentumHunter", philosophy);

        const live = {
            confidence: signal.confidence, risk: signal.risk,
            acceleration: signal.acceleration, reasons: signal.reasons, breakdown: signal.breakdown,
            riskReasons: signal.riskReasons, freshnessPenalty: signal.freshnessPenalty,
            // Live Decision Center sprint: this cycle's real rank, exactly
            // as tradingBotEngine.js's runCycle attaches it onto `live`
            // right before calling openPosition.
            rankAtEntry: 2, priorityScoreAtEntry: 71
        };

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));
        const result = await tm.openPosition(token, live, config, /* availableCash */ 1000);

        assert.equal(result.opened, true, `openPosition should succeed for a real, priced token (got: ${JSON.stringify(result)})`);

        const row = db.prepare("SELECT breakdown_json, rank_at_entry, priority_score_at_entry, risk FROM trading_bot_positions WHERE id = ?").get(result.positionId);
        assert.ok(row.breakdown_json, "breakdown_json must be populated, not null, for a real signal with a real breakdown");

        const parsed = JSON.parse(row.breakdown_json);
        assert.deepEqual(parsed.breakdown, signal.breakdown);
        assert.deepEqual(parsed.reasons, signal.reasons);
        assert.deepEqual(parsed.acceleration, signal.acceleration);
        assert.deepEqual(parsed.riskReasons, signal.riskReasons);
        assert.equal(parsed.freshnessPenalty, signal.freshnessPenalty);

        assert.equal(row.rank_at_entry, 2);
        assert.equal(row.priority_score_at_entry, 71);
        assert.equal(row.risk, signal.risk);

    }
    finally{
        deleteTestUser(userId);
    }

});

test("openPosition persists rank_at_entry: null / priority_score_at_entry: null when Opportunity Priority didn't run this cycle (never a fabricated rank)", async () => {

    const testEmail = `tradermanager.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const token = gmgnTokenRepository.getAllTokens().find(t => t.market_cap > 0 && t.price > 0);
        assert.ok(token);

        const live = { confidence: 80, risk: "LOW" }; // no .rankAtEntry - exactly the legacy-ordering/benchmark shape
        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));
        const result = await tm.openPosition(token, live, config, 1000);

        assert.equal(result.opened, true);
        const row = db.prepare("SELECT rank_at_entry, priority_score_at_entry, risk FROM trading_bot_positions WHERE id = ?").get(result.positionId);
        assert.equal(row.rank_at_entry, null);
        assert.equal(row.priority_score_at_entry, null);
        assert.equal(row.risk, "LOW");

    }
    finally{
        deleteTestUser(userId);
    }

});

// Trust/UX sprint: proves closeIfDue() now detects a real, zero on-chain
// balance and closes honestly as SELL_EXTERNAL, BEFORE ever reaching the
// Quality Gate / Dynamic Exit re-checks - previously nothing detected
// this at all and the position sat OPEN forever. Uses a fake
// balanceService (no real RPC/network) - executionService is
// deliberately left unimplemented to prove this path never attempts a
// real SELL (there's nothing left to sell).
test("closeIfDue detects an external sell (real balance already zero) and closes as SELL_EXTERNAL, never attempting a real SELL", async () => {

    const testEmail = `tradermanager.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenExternalSell111", tokenSymbol: "EXT",
            entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.2, targetMarketCap: null, stopLossPrice: 0.9, stopLossMarketCap: null
        });
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);

        const liveOptions = {
            userId, walletPublicKey: "FakeWalletForTest111",
            balanceService: { async getSplTokenBalance(){ return { amountRaw: "0", decimals: 6, uiAmount: 0 }; } },
            executionService: { async execute(){ throw new Error("must never be called - nothing real to sell"); } },
            convertUsdToLamports: async () => { throw new Error("must never be called"); }
        };

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId), liveOptions);

        const token = { token_address: "TestTokenExternalSell111", price: 1.05, symbol: "EXT" };
        const result = await tm.closeIfDue(position, token, config);

        assert.equal(result.closed, true);
        assert.equal(result.reason, "SELL_EXTERNAL");

        const closedPosition = db.prepare("SELECT status FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(closedPosition.status, "CLOSED");

        const trade = db.prepare("SELECT reason, tx_hash FROM trading_bot_trades WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId);
        assert.equal(trade.reason, "SELL_EXTERNAL"); // never the _NO_REAL_BALANCE suffix - that's a different, pre-existing case
        assert.equal(trade.tx_hash, null); // no real execution happened - nothing to attribute a hash to

    }
    finally{
        deleteTestUser(userId);
    }

});

test("openPosition writes breakdown_json: null when live carries no breakdown (benchmark/ab-test stubs, unchanged)", async () => {

    const testEmail = `tradermanager.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const token = gmgnTokenRepository.getAllTokens().find(t => t.market_cap > 0 && t.price > 0);
        assert.ok(token);

        const live = { confidence: 80, risk: "LOW" }; // no .breakdown - exactly today's benchmark/ab-test signal stub shape
        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));
        const result = await tm.openPosition(token, live, config, 1000);

        assert.equal(result.opened, true);
        const row = db.prepare("SELECT breakdown_json FROM trading_bot_positions WHERE id = ?").get(result.positionId);
        assert.equal(row.breakdown_json, null);

    }
    finally{
        deleteTestUser(userId);
    }

});

// Trading Configuration sprint: FIXED_USD sizing mode - a real, Founder-
// set fixed USD amount, still capped by the real max_position_size
// ceiling and floored by min_order_size, exactly like PERCENT mode.
// Never touches which token gets bought or when.
test("openPosition sizes a real position using FIXED_USD mode, still capped by max_position_size", async () => {

    const testEmail = `tradermanager.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const token = gmgnTokenRepository.getAllTokens().find(t => t.market_cap > 0 && t.price > 0);
        assert.ok(token);

        const live = { confidence: 80, risk: "LOW" };
        // $15 - above the real default min_order_size floor ($10), below
        // the real default max_position_size ceiling ($100).
        tradingBotRepository.updateConfig(userId, { position_sizing_mode: "FIXED_USD", fixed_position_size_usd: 15 });
        const config = tradingBotRepository.getConfig(userId);
        assert.equal(config.position_sizing_mode, "FIXED_USD");

        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));
        const result = await tm.openPosition(token, live, config, 1000); // plenty of availableCash - FIXED_USD must ignore it, never scale with balance

        assert.equal(result.opened, true);
        assert.equal(result.sizeUsd, 15, "FIXED_USD mode must use the real fixed amount, never the percent-of-balance formula");

        const row = db.prepare("SELECT size_usd FROM trading_bot_positions WHERE id = ?").get(result.positionId);
        assert.equal(row.size_usd, 15);

    }
    finally{
        deleteTestUser(userId);
    }

});

test("openPosition's FIXED_USD size is still capped by the real max_position_size ceiling", async () => {

    const testEmail = `tradermanager.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const token = gmgnTokenRepository.getAllTokens().find(t => t.market_cap > 0 && t.price > 0);
        assert.ok(token);

        const live = { confidence: 80, risk: "LOW" };
        // Fixed amount ($500) deliberately set ABOVE the real max_position_size
        // ceiling (default $100) - the cap must still apply.
        tradingBotRepository.updateConfig(userId, { position_sizing_mode: "FIXED_USD", fixed_position_size_usd: 500 });
        const config = tradingBotRepository.getConfig(userId);

        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));
        const result = await tm.openPosition(token, live, config, 1000);

        assert.equal(result.opened, true);
        assert.equal(result.sizeUsd, config.max_position_size, "the real max_position_size ceiling must still cap a fixed amount that exceeds it");

    }
    finally{
        deleteTestUser(userId);
    }

});

// Position Detail timeline (Live Decision Center sprint): mfe_at/mae_at
// must be stamped ONLY the cycle a real new peak/trough is reached, and
// left unchanged on every other cycle. This exercises
// updatePositionTracking directly (the exact calls tradeManager.js's
// closeIfDue makes, mirroring its own mfeAt/maeAt selection logic) rather
// than the full closeIfDue -> quality gate -> dynamic exit pipeline -
// the real engine's own veto (a bare-bones test token has no real
// liquidity/holders data, so it would always be classified AVOID and
// close on the REVERSAL check, which is a different, already-covered
// concern) would otherwise make this specific persistence question
// impossible to isolate deterministically.
test("updatePositionTracking stamps mfe_at only on a genuinely new peak, and leaves it unchanged when the price later retreats", () => {

    const testEmail = `tradermanager.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenMfeAt111", tokenSymbol: "MFE",
            entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 999, targetMarketCap: null, stopLossPrice: 0.01, stopLossMarketCap: null
        });

        // Cycle 1: price up 20% - a genuine new peak vs. the row's own
        // default mfe_pct (0) - mfeAt must be computed and stamped, same
        // "mfePctNow > position.mfe_pct" comparison tradeManager.js's
        // closeIfDue makes.
        let position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        let mfePctNow = Math.max(position.mfe_pct || 0, 20);
        let maePctNow = Math.min(position.mae_pct || 0, 20);
        let mfeAt = mfePctNow > (position.mfe_pct || 0) ? new Date().toISOString() : (position.mfe_at ?? null);
        let maeAt = maePctNow < (position.mae_pct || 0) ? new Date().toISOString() : (position.mae_at ?? null);
        tradingBotRepository.updatePositionTracking(positionId, { currentPrice: 1.20, mfePct: mfePctNow, maePct: maePctNow, lastVolume1h: null, mfeAt, maeAt });

        position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.ok(position.mfe_at, "mfe_at must be stamped on a genuine new peak");
        assert.equal(position.mae_at, null); // never a drawdown yet - never fabricated
        const firstMfeAt = position.mfe_at;

        // Cycle 2: price retreats to +5% - still positive, but NOT a new
        // peak (peak was +20%) - mfe_at must be forwarded UNCHANGED, never
        // wiped back to null just because this cycle found no new extreme.
        mfePctNow = Math.max(position.mfe_pct || 0, 5);
        maePctNow = Math.min(position.mae_pct || 0, 5);
        mfeAt = mfePctNow > (position.mfe_pct || 0) ? new Date().toISOString() : (position.mfe_at ?? null);
        maeAt = maePctNow < (position.mae_pct || 0) ? new Date().toISOString() : (position.mae_at ?? null);
        tradingBotRepository.updatePositionTracking(positionId, { currentPrice: 1.05, mfePct: mfePctNow, maePct: maePctNow, lastVolume1h: null, mfeAt, maeAt });

        position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(position.mfe_at, firstMfeAt, "mfe_at must NOT change when no new peak is reached this cycle");
        assert.equal(Number(position.mfe_pct.toFixed(2)), 20); // the recorded peak VALUE itself is untouched too

    }
    finally{
        deleteTestUser(userId);
    }

});

// Momentum Validation System sprint: crossed_5pct_at/crossed_10pct_at
// must be stamped exactly once, the cycle each real threshold is first
// crossed, and never re-stamped or wiped on later cycles - same
// first-crossing contract mfe_at/mae_at already proved above.
test("updatePositionTracking stamps crossed_5pct_at/crossed_10pct_at only on the genuine first crossing of each threshold", () => {

    const testEmail = `tradermanager.test.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenCrossPct111", tokenSymbol: "XPCT",
            entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 999, targetMarketCap: null, stopLossPrice: 0.01, stopLossMarketCap: null
        });

        function tick(position, roiPct){
            const mfePctNow = Math.max(position.mfe_pct || 0, roiPct);
            const maePctNow = Math.min(position.mae_pct || 0, roiPct);
            const crossed5pctAt = mfePctNow >= 5 && (position.mfe_pct || 0) < 5 ? new Date().toISOString() : (position.crossed_5pct_at ?? null);
            const crossed10pctAt = mfePctNow >= 10 && (position.mfe_pct || 0) < 10 ? new Date().toISOString() : (position.crossed_10pct_at ?? null);
            tradingBotRepository.updatePositionTracking(positionId, {
                currentPrice: 1 + roiPct / 100, mfePct: mfePctNow, maePct: maePctNow, lastVolume1h: null,
                mfeAt: null, maeAt: null, crossed5pctAt, crossed10pctAt
            });
            return db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        }

        // Cycle 1: +3% - neither threshold crossed yet
        let position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        position = tick(position, 3);
        assert.equal(position.crossed_5pct_at, null);
        assert.equal(position.crossed_10pct_at, null);

        // Cycle 2: +7% - crosses +5%, not yet +10%
        position = tick(position, 7);
        assert.ok(position.crossed_5pct_at, "crossed_5pct_at must be stamped on the genuine first crossing");
        assert.equal(position.crossed_10pct_at, null);
        const crossed5At = position.crossed_5pct_at;

        // Cycle 3: +12% - crosses +10%; crossed_5pct_at must be untouched
        position = tick(position, 12);
        assert.equal(position.crossed_5pct_at, crossed5At, "crossed_5pct_at must not be re-stamped once already set");
        assert.ok(position.crossed_10pct_at, "crossed_10pct_at must be stamped on its own genuine first crossing");

        // Cycle 4: retreats to +6% - both timestamps must remain unchanged
        const crossed10At = position.crossed_10pct_at;
        position = tick(position, 6);
        assert.equal(position.crossed_5pct_at, crossed5At);
        assert.equal(position.crossed_10pct_at, crossed10At, "crossed_10pct_at must never be wiped just because ROI later retreats");

    }
    finally{
        deleteTestUser(userId);
    }

});
