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
const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
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
            // False Positive Reduction V2, Priority 5: real signal fields
            // this sprint added - missingEvidence/confidenceBreakdown,
            // exactly as tradingBotScheduler.js's real liveMap now carries
            // them through unmodified.
            missingEvidence: signal.missingEvidence, confidenceBreakdown: signal.confidenceBreakdown,
            participantScore: signal.participantScore, participantMax: signal.participantMax,
            // Live Decision Center sprint: this cycle's real rank, exactly
            // as tradingBotEngine.js's runCycle attaches it onto `live`
            // right before calling openPosition.
            rankAtEntry: 2, priorityScoreAtEntry: 71,
            // Production Stabilization Final, Section G/H: the entry
            // gate's own real result, exactly as tradingBotEngine.js's
            // runCycle attaches it onto `live` right before this call.
            decayFraction: 1,
            entryGateResult: { eligible: true, isReentry: false, marketAgeSeconds: 12.5, decayFraction: 1 }
        };

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));
        const result = await tm.openPosition(token, live, config, /* availableCash */ 1000);

        assert.equal(result.opened, true, `openPosition should succeed for a real, priced token (got: ${JSON.stringify(result)})`);

        const row = db.prepare("SELECT breakdown_json, rank_at_entry, priority_score_at_entry, risk, config_snapshot_json FROM trading_bot_positions WHERE id = ?").get(result.positionId);
        assert.ok(row.breakdown_json, "breakdown_json must be populated, not null, for a real signal with a real breakdown");

        const parsed = JSON.parse(row.breakdown_json);
        assert.deepEqual(parsed.breakdown, signal.breakdown);
        assert.deepEqual(parsed.reasons, signal.reasons);
        assert.deepEqual(parsed.acceleration, signal.acceleration);
        assert.deepEqual(parsed.riskReasons, signal.riskReasons);
        assert.equal(parsed.freshnessPenalty, signal.freshnessPenalty);

        // False Positive Reduction V2, Priority 5: the full evidence
        // picture - missing evidence, the full confidence penalty
        // breakdown, and a real, non-empty final pass-reason narrative -
        // must all be genuinely persisted, not discarded like breakdown
        // itself was before the earlier Trust/UX sprint fix.
        assert.deepEqual(parsed.missingEvidence, signal.missingEvidence);
        assert.deepEqual(parsed.confidenceBreakdown, signal.confidenceBreakdown);
        assert.ok(parsed.passReason, "passReason must be a real, non-empty narrative for every real BUY");
        assert.ok(parsed.passReason.includes(String(signal.participantScore)), "passReason must cite the real participantScore, not a placeholder");
        assert.ok(parsed.passReason.includes(config.min_confidence != null ? String(config.min_confidence) : ""), "passReason must cite the real confidence floor active at decision time");

        // Production Stabilization Final, Section G/H: the entry gate's
        // own real result must be persisted verbatim, not discarded.
        assert.deepEqual(parsed.entryGateResult, { eligible: true, isReentry: false, marketAgeSeconds: 12.5, decayFraction: 1 });

        // False Positive Reduction V4: tokenAgeMinutesAtEntry must be a
        // real, non-negative number (or null, if this real token genuinely
        // has no real launch/trenches-creation timestamp) - never
        // silently dropped from the persisted record.
        assert.ok(parsed.tokenAgeMinutesAtEntry === null || parsed.tokenAgeMinutesAtEntry >= 0);

        assert.equal(row.rank_at_entry, 2);
        assert.equal(row.priority_score_at_entry, 71);
        assert.equal(row.risk, signal.risk);

        // Production Stabilization V1: the real trading_bot_config active
        // at decision time must be captured too - so a later profile
        // switch/Trading Configuration edit can never erase what actually
        // produced this BUY.
        assert.ok(row.config_snapshot_json, "config_snapshot_json must be populated for a real BUY");
        const configSnapshot = JSON.parse(row.config_snapshot_json);
        assert.equal(configSnapshot.min_confidence, config.min_confidence);
        assert.equal(configSnapshot.strategy_profile, config.strategy_profile);

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

// Production Stabilization V1 Final Sprint (Section I - Scheduler
// Safety): defense-in-depth verification for the BUY side - application
// logic already prevents a duplicate real BUY (verified: entryGateService's
// ALREADY_OPEN_FOR_TOKEN check, and runCycle's strictly-sequential
// per-candidate processing within one scheduler-guarded cycle), but
// migration 060's partial unique index now makes that a real, enforced
// database guarantee too - this proves the database itself, not just
// application code, refuses a second OPEN position for the same
// (user_id, token_address).
test("the database itself rejects a second OPEN position for the same user+token (migration 060)", () => {

    const testEmail = `tradermanager.test.dupe.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionFields = {
            tokenAddress: "TestTokenDupeGuard111", tokenSymbol: "DUPE",
            entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.2, targetMarketCap: null, stopLossPrice: 0.9, stopLossMarketCap: null
        };

        tradingBotRepository.insertPosition(userId, positionFields);
        assert.throws(
            () => tradingBotRepository.insertPosition(userId, positionFields),
            /UNIQUE constraint failed/
        );

    }
    finally{
        deleteTestUser(userId);
    }

});

// Production Stabilization V1 Final Sprint (Section I - Scheduler
// Safety): real, concrete race found this sprint - the scheduler's own
// automatic close (closeIfDue -> finalizeClose) and the dashboard's
// manual Force Sell/Sell Position (tradingBotService.js's forceSellAll/
// sellPosition) are two independent call paths with no shared lock; both
// could reach finalizeClose() for the SAME position.id if a manual sell
// happens to land while the scheduler is mid-cycle for that position.
// Simulated directly here by calling finalizeClose() twice for the same
// already-fetched position row (exactly what two racing callers would
// each hold) - the second call must NOT insert a second trade row or
// re-log a SELL that didn't really happen a second time.
test("finalizeClose is idempotent - a second call for an already-closed position never inserts a duplicate trade row", async () => {

    const testEmail = `tradermanager.test.race.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenRaceClose111", tokenSymbol: "RACE",
            entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.2, targetMarketCap: null, stopLossPrice: 0.9, stopLossMarketCap: null
        });
        // Both racing callers would each independently fetch the SAME
        // real, still-OPEN row before either one closes it.
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId)); // SIMULATION - no liveOptions, isolates the DB-level race from real execution

        const first = await tm.finalizeClose(position, 1.1, "STOP_LOSS", config);
        const second = await tm.finalizeClose(position, 1.1, "STOP_LOSS", config);

        assert.equal(first.closed, true);
        assert.equal(second.closed, false);
        assert.equal(second.reason, "ALREADY_CLOSED");

        const trades = db.prepare("SELECT * FROM trading_bot_trades WHERE user_id = ? AND token_address = ?").all(userId, "TestTokenRaceClose111");
        assert.equal(trades.length, 1, "exactly one trade row must exist, never a duplicate from the second racing call");

        const sellLogs = db.prepare("SELECT * FROM trading_bot_log WHERE user_id = ? AND log_type = 'SELL'").all(userId);
        assert.equal(sellLogs.length, 1, "exactly one real SELL log line must exist, never a phantom second one");

    }
    finally{
        deleteTestUser(userId);
    }

});

// False Positive Reduction V4: a real, deterministic token age, computed
// from a known launch_time, must be persisted exactly - this is the
// same real formula this sprint's fix in tokenTransformer.js/emiService.js
// finally made trustworthy (GMGN's open_timestamp:0 "unknown" sentinel no
// longer read as a real 1970 launch date).
test("openPosition persists a real, correctly-computed tokenAgeMinutesAtEntry", async () => {

    const testEmail = `tradermanager.test.age.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const baseToken = gmgnTokenRepository.getAllTokens().find(t => t.market_cap > 0 && t.price > 0);
        assert.ok(baseToken);

        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60000).toISOString().slice(0, 19).replace("T", " ");
        const token = { ...baseToken, launch_time: thirtyMinutesAgo };

        const philosophy = strategyProfileTranslator.translate(strategyProfileConfig.resolveProfile("AGGRESSIVE")).philosophy;
        const ctx = researchEngineFactory.preloadContext([token]);
        const [signal] = researchEngineFactory.analyzeTokensWithOverride([token], ctx, "momentumHunter", philosophy);

        const live = {
            confidence: signal.confidence, risk: signal.risk === "HIGH" ? "MEDIUM" : signal.risk,
            reasons: signal.reasons, breakdown: signal.breakdown, riskReasons: signal.riskReasons,
            freshnessPenalty: signal.freshnessPenalty, participantScore: signal.participantScore, participantMax: signal.participantMax
        };

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));
        const result = await tm.openPosition(token, live, config, 1000);

        assert.equal(result.opened, true, `expected a real BUY (got: ${JSON.stringify(result)})`);
        const row = db.prepare("SELECT breakdown_json FROM trading_bot_positions WHERE id = ?").get(result.positionId);
        const parsed = JSON.parse(row.breakdown_json);

        assert.ok(parsed.tokenAgeMinutesAtEntry != null, "a real launch_time was set - age must be computed, never null");
        assert.ok(Math.abs(parsed.tokenAgeMinutesAtEntry - 30) < 1, `expected ~30 minutes, got ${parsed.tokenAgeMinutesAtEntry}`);

    }
    finally{
        deleteTestUser(userId);
    }

});

// Production Stabilization V2 (Close Remaining BUY Blind Spots, Section
// 5 - Position Snapshot): every real, raw fact behind the persisted
// scores must be captured too, not just the derived scores - so a
// future replay against a changed scoringConfig.js can genuinely
// recompute, not just re-read the same old number. Same monkey-patch
// pattern already established in qualityGateService.test.js/
// entryGateService.test.js for this exact real-DB dependency.
test("openPosition persists the real, raw facts (rug ratio, dev balance, sniper hold rate, etc.) behind every score", async () => {

    const testEmail = `tradermanager.test.facts.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    const originalFindByTokenAddress = gmgnTrenchesRepository.findByTokenAddress;

    try{

        const baseToken = gmgnTokenRepository.getAllTokens().find(t => t.market_cap > 0 && t.price > 0);
        assert.ok(baseToken);
        const token = { ...baseToken, liquidity: 12345, market_cap: 67890, holders: 42 };

        gmgnTrenchesRepository.findByTokenAddress = () => ({
            rug_ratio: 0.12, top_10_holder_rate: 0.35, smart_degen_count: 2, sniper_count: 1,
            net_buy_24h: 999, is_honeypot: 0,
            raw_json: JSON.stringify({
                creator_balance_rate: 0.08, top70_sniper_hold_rate: 0.22, bundler_mhr: 0.05,
                suspected_insider_hold_rate: 0.01, creator_created_count: 2, creator_created_open_ratio: 0.5
            })
        });

        const philosophy = strategyProfileTranslator.translate(strategyProfileConfig.resolveProfile("AGGRESSIVE")).philosophy;
        const ctx = researchEngineFactory.preloadContext([token]);
        const [signal] = researchEngineFactory.analyzeTokensWithOverride([token], ctx, "momentumHunter", philosophy);

        const live = {
            confidence: signal.confidence, risk: signal.risk === "HIGH" ? "MEDIUM" : signal.risk,
            reasons: signal.reasons, breakdown: signal.breakdown, riskReasons: signal.riskReasons,
            freshnessPenalty: signal.freshnessPenalty, participantScore: signal.participantScore, participantMax: signal.participantMax
        };

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));
        const result = await tm.openPosition(token, live, config, 1000);

        assert.equal(result.opened, true, `expected a real BUY (got: ${JSON.stringify(result)})`);
        const row = db.prepare("SELECT breakdown_json FROM trading_bot_positions WHERE id = ?").get(result.positionId);
        const parsed = JSON.parse(row.breakdown_json);

        assert.ok(parsed.rawFactsAtEntry, "rawFactsAtEntry must be persisted");
        assert.equal(parsed.rawFactsAtEntry.liquidity, 12345);
        assert.equal(parsed.rawFactsAtEntry.marketCap, 67890);
        assert.equal(parsed.rawFactsAtEntry.holders, 42);
        assert.equal(parsed.rawFactsAtEntry.rugRatio, 0.12);
        assert.equal(parsed.rawFactsAtEntry.top10HolderRate, 0.35);
        assert.equal(parsed.rawFactsAtEntry.developerBalanceRate, 0.08);
        assert.equal(parsed.rawFactsAtEntry.sniperHoldRate, 0.22);
        assert.equal(parsed.rawFactsAtEntry.bundlerMhr, 0.05);
        assert.equal(parsed.rawFactsAtEntry.insiderHoldRate, 0.01);
        assert.equal(parsed.rawFactsAtEntry.creatorCreatedCount, 2);

    }
    finally{
        gmgnTrenchesRepository.findByTokenAddress = originalFindByTokenAddress;
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

// =====================================
// Arjuna V3 (FINAL SPRINT), Part 10 - partial-exit wiring end to end
// (tradeManager.js's new partialClose + tradingBotRepository.js's new
// partialClosePosition). healthyToken keeps Step 7's Momentum Health
// emergency check comfortably above its floor so these tests only ever
// exercise the TP1/profit-protection logic they mean to.
// =====================================

function healthyToken(overrides = {}){
    return {
        token_address: "TestTokenArjunaV3Exit111", symbol: "AV3", price: 1.0,
        price_change_5m: 5, price_change_1h: 10, volume_1h: 1500, liquidity: 10000, market_cap: 100000,
        buys_5m: 8, sells_5m: 2,
        ...overrides
    };
}

test("closeIfDue: TP1 (+25%) sells 80% (Arjuna V4, Part 3), keeps the position OPEN with a reduced size, stamps tp1_hit_at, and inserts a real partial trade row", async () => {

    const testEmail = `tradermanager.test.tp1.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenArjunaV3Exit111", tokenSymbol: "AV3",
            entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 2, targetMarketCap: null, stopLossPrice: 0.8, stopLossMarketCap: null
        });
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(position.initial_size_usd, 10);

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));

        const token = healthyToken({ price: 1.25 }); // exactly +25% - TP1
        const result = await tm.closeIfDue(position, token, config);

        assert.equal(result.closed, false);
        assert.equal(result.partiallyClosed, true);
        assert.equal(result.reason, "TP1");

        const updated = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(updated.status, "OPEN", "TP1 must never close the position");
        assert.equal(updated.size_usd, 2, "80% of the original $10 size must be sold - $2 (Free Ride Mode) remains");
        assert.equal(updated.initial_size_usd, 10, "the original size must never change");
        assert.ok(updated.tp1_hit_at, "tp1_hit_at must be stamped");
        assert.equal(updated.tp1_price, 1.25);
        assert.ok(updated.realized_pnl_usd > 0, "the sold 80% at +25% must lock in a real positive realized PnL");

        const partialTrade = db.prepare("SELECT * FROM trading_bot_trades WHERE user_id = ? AND reason = 'TP1'").get(userId);
        assert.ok(partialTrade, "the sold portion must be recorded as its own real trade row");
        assert.equal(partialTrade.size_usd, 8);
        assert.equal(partialTrade.exit_classification, "PARTIAL_TP1");

    }
    finally{
        deleteTestUser(userId);
    }

});

test("closeIfDue: TP1 does not re-fire on a position that already has tp1_hit_at set", async () => {

    const testEmail = `tradermanager.test.tp1once.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenArjunaV3Exit222", tokenSymbol: "AV3B",
            entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 2, targetMarketCap: null, stopLossPrice: 0.8, stopLossMarketCap: null
        });

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));

        // Manually put the position into a post-TP1 (Free Ride Mode)
        // state (as if a prior cycle already ran TP1), then re-check at
        // the same +25% price - must NOT sell another 80%.
        db.prepare("UPDATE trading_bot_positions SET tp1_hit_at = CURRENT_TIMESTAMP, tp1_price = 1.25, size_usd = 2 WHERE id = ?").run(positionId);
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);

        const token = healthyToken({ price: 1.25, price_change_5m: 1 }); // still +25% remaining ROI - below TP2 (100%), timer not expired
        const result = await tm.closeIfDue(position, token, config);

        assert.equal(result.closed, false);
        assert.notEqual(result.partiallyClosed, true);

        const updated = db.prepare("SELECT size_usd FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(updated.size_usd, 2, "size must be unchanged - no second partial sell");

    }
    finally{
        deleteTestUser(userId);
    }

});

test("closeIfDue: Free Ride Mode holds through a real pullback (no Profit Protection step anymore), then TP2 (+100%) closes the remainder", async () => {

    const testEmail = `tradermanager.test.tp2.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenArjunaV3Exit333", tokenSymbol: "AV3C",
            entryPrice: 1.0, sizeUsd: 2, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 2, targetMarketCap: null, stopLossPrice: 0.8, stopLossMarketCap: null
        });
        db.prepare("UPDATE trading_bot_positions SET tp1_hit_at = CURRENT_TIMESTAMP, tp1_price = 1.25, initial_size_usd = 10 WHERE id = ?").run(positionId);

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));

        // A real pullback to +10% must NOT close the Free Ride remainder -
        // Arjuna V4 explicitly removed the old Profit Protection floor.
        const pulledBackPosition = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        const holdResult = await tm.closeIfDue(pulledBackPosition, healthyToken({ price: 1.10 }), config);
        assert.equal(holdResult.closed, false);

        const stillOpen = db.prepare("SELECT status FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(stillOpen.status, "OPEN");

        // TP2 at +100% closes the whole remainder.
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        const result = await tm.closeIfDue(position, healthyToken({ price: 2.00 }), config);

        assert.equal(result.closed, true);
        assert.equal(result.reason, "TP2");

        const closedPosition = db.prepare("SELECT status FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(closedPosition.status, "CLOSED");

        const trade = db.prepare("SELECT * FROM trading_bot_trades WHERE user_id = ? AND reason = 'TP2'").get(userId);
        assert.ok(trade);
        assert.equal(trade.exit_classification, "NORMAL");

    }
    finally{
        deleteTestUser(userId);
    }

});

// =====================================
// Arjuna V3 (FINAL SPRINT), Parts 12/13 - the permanent self-learning
// trade dataset and MUPP exit-failure classification, end to end
// through a real finalizeClose.
// =====================================

test("finalizeClose persists the full self-learning dataset (participantScore/confidence/holders/liquidity/reasons) from the position's own breakdown_json", async () => {

    const testEmail = `tradermanager.test.dataset.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const breakdownJson = JSON.stringify({
            participantScore: 72, marketHealth: 65,
            tokenAgeMinutesAtEntry: 18.4,
            rawFactsAtEntry: { holders: 140, liquidity: 45000, volume1h: 22000 },
            reasons: ["Net accumulation detected"],
            riskReasons: ["Very low liquidity"],
            breakdown: { participant: { smartMoney: { score: 14, max: 20, hasData: true } }, market: { liquidity: { score: 10, max: 15 } } },
            momentumPhase: "EARLY_MOMENTUM"
        });

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenDataset111", tokenSymbol: "DATA", entryPrice: 1.0, sizeUsd: 10,
            confidence: 55, exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.5, targetMarketCap: null, stopLossPrice: 0.8, stopLossMarketCap: null,
            breakdownJson
        });
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));
        await tm.finalizeClose(position, 1.10, "TEST_CLOSE", config);

        const trade = db.prepare("SELECT * FROM trading_bot_trades WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId);
        assert.equal(trade.confidence, 55);
        assert.equal(trade.participant_score, 72);
        assert.equal(trade.market_health, 65);
        assert.equal(trade.token_age_minutes_at_entry, 18.4);
        assert.equal(trade.holders_at_entry, 140);
        assert.equal(trade.liquidity_at_entry, 45000);
        assert.equal(trade.volume_1h_at_entry, 22000);
        assert.deepEqual(JSON.parse(trade.entry_reasons_json), ["Net accumulation detected"]);
        assert.deepEqual(JSON.parse(trade.risk_reasons_json), ["Very low liquidity"]);
        assert.ok(JSON.parse(trade.module_scores_json).participant.smartMoney);
        // Production trading-quality audit, Phase 4 (2026-08-06, migration
        // 073): momentumPhase must be projected onto its own column too,
        // same "project once, read cheaply later" pattern as every other
        // field above - proves a future correlation query never has to
        // reach back into breakdown_json.
        assert.equal(trade.momentum_phase_at_entry, "EARLY_MOMENTUM");

    }
    finally{
        deleteTestUser(userId);
    }

});

test("Part 13 MUPP: a trade that reached +82% then exits at -81% is classified EXIT_FAILURE, not an ordinary loss", async () => {

    const testEmail = `tradermanager.test.mupp.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenMupp111", tokenSymbol: "MUPP", entryPrice: 1.0, sizeUsd: 10,
            confidence: 55, exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.5, targetMarketCap: null, stopLossPrice: 0.19, stopLossMarketCap: null
        });
        tradingBotRepository.updatePositionTracking(positionId, { currentPrice: 1.82, mfePct: 82, maePct: -81, lastVolume1h: null });
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));
        await tm.finalizeClose(position, 0.19, "STOP_LOSS", config); // -81%

        const trade = db.prepare("SELECT * FROM trading_bot_trades WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId);
        assert.equal(trade.mfe_pct, 82);
        assert.ok(trade.roi_pct < -75);
        assert.equal(trade.exit_classification, "EXIT_FAILURE");

    }
    finally{
        deleteTestUser(userId);
    }

});

test("Part 13 MUPP: an ordinary loss with no real unrealized peak is classified BAD_ENTRY, not EXIT_FAILURE", async () => {

    const testEmail = `tradermanager.test.badentry.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenBadEntry111", tokenSymbol: "BADE", entryPrice: 1.0, sizeUsd: 10,
            confidence: 55, exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.5, targetMarketCap: null, stopLossPrice: 0.8, stopLossMarketCap: null
        });
        tradingBotRepository.updatePositionTracking(positionId, { currentPrice: 0.85, mfePct: 2, maePct: -18, lastVolume1h: null }); // never had real upside
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));
        await tm.finalizeClose(position, 0.8, "STOP_LOSS", config);

        const trade = db.prepare("SELECT * FROM trading_bot_trades WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId);
        assert.equal(trade.mfe_pct, 2);
        assert.equal(trade.exit_classification, "BAD_ENTRY");

    }
    finally{
        deleteTestUser(userId);
    }

});

// =====================================
// Arjuna V4 (Sprint 11), Part 1/2 - real ROI accounting end to end.
// The core of the sprint: a LIVE round trip's realized_roi_pct comes
// from real actualAmounts (never token.price), a SIMULATION trade falls
// back honestly (roi_version='v1_simulated'), and every consumer reads
// the SAME realized_roi_pct field regardless of which path produced it.
// =====================================

test("LIVE round trip: realized_roi_pct comes from REAL SOL amounts, not the snapshot price ratio - proves Trade B's exact real-world shape (snapshot says -31%, real chain says ~breakeven)", async () => {

    const testEmail = `tradermanager.test.realroi.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const liveOptions = {
            userId, walletPublicKey: "FakeWalletRealRoi111",
            convertUsdToLamports: async () => ({ lamports: 34_814_000, solUsdPrice: 150 }),
            executionService: {
                async execute({ action }){
                    if(action === "BUY"){
                        return {
                            executionId: 1, outcome: "SUCCESS", txHash: "buy-sig-real-roi",
                            actualAmounts: { solDeltaLamports: -34_814_000, tokenDeltaUi: 1_000_000, blockTime: 1785000000, slot: 1 }
                        };
                    }
                    // SELL - real chain result lands near breakeven, even
                    // though the DECISION-time snapshot price used for
                    // exitPrice below implies a much worse -31% ratio -
                    // exactly the real Trade B mismatch this sprint exists
                    // to fix.
                    return {
                        executionId: 2, outcome: "SUCCESS", txHash: "sell-sig-real-roi",
                        actualAmounts: { solDeltaLamports: 34_700_000, tokenDeltaUi: -1_000_000, blockTime: 1785000600, slot: 2 }
                    };
                }
            },
            balanceService: { async getSplTokenBalance(){ return { amountRaw: "1000000", decimals: 6, uiAmount: 1 }; } }
        };

        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId), liveOptions);
        const config = tradingBotRepository.getConfig(userId);

        const token = { token_address: "TestTokenRealRoi111", symbol: "ROI", price: 0.001, market_cap: 100000, liquidity: 20000 };
        const live = { action: "BUY", confidence: 60, hasDecision: true };
        const openResult = await tm.openPosition(token, live, config, 100);
        assert.equal(openResult.opened, true, `open must succeed for this test to mean anything (reason=${openResult.reason})`);

        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(openResult.positionId);
        assert.equal(position.entry_tx_signature, "buy-sig-real-roi");
        assert.ok(Math.abs(position.actual_sol_spent - 0.034814) < 1e-9);

        // exitPrice deliberately implies a snapshot-based roiPct far
        // worse than reality (~-31%, matching the real Trade B report),
        // to prove realized_roi_pct is NOT derived from it.
        const badSnapshotExitPrice = 0.00069;
        await tm.finalizeClose(position, badSnapshotExitPrice, "STOP_LOSS", config);

        const trade = db.prepare("SELECT * FROM trading_bot_trades WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId);
        assert.equal(trade.roi_version, "v1_onchain");
        assert.ok(Math.abs(trade.actual_sol_spent - 0.034814) < 1e-9);
        assert.ok(Math.abs(trade.actual_sol_received - 0.0347) < 1e-9);
        assert.equal(trade.entry_tx_signature, "buy-sig-real-roi");
        assert.equal(trade.exit_tx_signature, "sell-sig-real-roi");
        assert.equal(trade.entry_block_time, 1785000000);
        assert.equal(trade.exit_block_time, 1785000600);

        // The legacy snapshot roi_pct is still ~-31% (proving the OLD
        // number really would have been that wrong) - but realized_roi_pct
        // must be near breakeven, from the real SOL amounts.
        assert.ok(trade.roi_pct < -25, `legacy snapshot roi_pct should show the bad ratio, got ${trade.roi_pct}`);
        assert.ok(Math.abs(trade.realized_roi_pct) < 2, `realized_roi_pct should be near breakeven (real SOL), got ${trade.realized_roi_pct}`);

        // FINAL PRODUCTION SPRINT P0 (Exit Log - "Actual Exit Price"):
        // real SOL received (0.0347) / real token quantity sold
        // (1,000,000, from actualAmounts.tokenDeltaUi = -1,000,000) -
        // an observability fact, distinct from and never fed into
        // realized_roi_pct above.
        assert.ok(Math.abs(trade.actual_exit_price - (0.0347 / 1_000_000)) < 1e-12, `actual_exit_price should be the real fill price, got ${trade.actual_exit_price}`);

    }
    finally{
        deleteTestUser(userId);
    }

});

test("SIMULATION trade: realized_roi_pct falls back to the snapshot ratio, honestly tagged roi_version='v1_simulated' - never fabricates real SOL amounts", async () => {

    const testEmail = `tradermanager.test.simroi.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenSimRoi111", tokenSymbol: "SIMROI", entryPrice: 1.0, sizeUsd: 10,
            confidence: 55, exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.5, targetMarketCap: null, stopLossPrice: 0.8, stopLossMarketCap: null
        });
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(position.actual_sol_spent, null, "SIMULATION never has real SOL - must stay null, never fabricated");

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId)); // no liveOptions - SIMULATION
        await tm.finalizeClose(position, 1.20, "TP2", config);

        const trade = db.prepare("SELECT * FROM trading_bot_trades WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId);
        assert.equal(trade.roi_version, "v1_simulated");
        assert.equal(trade.actual_sol_spent, null);
        assert.equal(trade.actual_sol_received, null);
        assert.equal(trade.realized_pnl_sol, null);
        // For SIMULATION, realized_roi_pct is IDENTICAL to the legacy
        // snapshot roi_pct (same underlying values, just routed through
        // the shared roiCalculator helper) - single source of truth,
        // not two independently-drifting numbers.
        assert.equal(trade.realized_roi_pct, trade.roi_pct);
        assert.ok(Math.abs(trade.realized_roi_pct - 20) < 1e-9);

    }
    finally{
        deleteTestUser(userId);
    }

});

test("dataset_version is stamped on every trade row (Arjuna V4, Part 6 - self-learning versioning)", async () => {

    const testEmail = `tradermanager.test.datasetversion.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenDatasetVer111", tokenSymbol: "DVER", entryPrice: 1.0, sizeUsd: 10,
            confidence: 55, exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.5, targetMarketCap: null, stopLossPrice: 0.8, stopLossMarketCap: null
        });
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));
        await tm.finalizeClose(position, 1.05, "TEST_CLOSE", config);

        const trade = db.prepare("SELECT dataset_version, engine_version FROM trading_bot_trades WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId);
        assert.equal(trade.dataset_version, "v2_realized_roi");
        assert.equal(trade.engine_version, "production_v2");

    }
    finally{
        deleteTestUser(userId);
    }

});

// =====================================
// FINAL PRODUCTION SPRINT P0 - root cause: executionService.execute()
// THROWS synchronously (not a FAILED outcome) when this wallet already
// has another execution in flight (a real BUY racing a real SELL on
// independent scheduler timers). Before this fix, that throw propagated
// all the way past finalizeClose/partialClose uncaught - the position
// looked silently stuck with zero DB trail. Proves it's now caught,
// logged, and retried like any other non-SUCCESS outcome.
// =====================================

test("finalizeClose: a wallet-contention throw from executionService.execute() is caught, logged, and retried - not left silently uncaught with zero DB trail", async () => {

    const testEmail = `tradermanager.test.contention.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenContention111", tokenSymbol: "CONTEND", entryPrice: 1.0, sizeUsd: 10,
            confidence: 55, exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.5, targetMarketCap: null, stopLossPrice: 0.8, stopLossMarketCap: null
        });
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);

        const liveOptions = {
            userId, walletPublicKey: "FakeWalletContention111",
            executionService: {
                async execute(){
                    throw new Error("executionService: user already has an active execution (#1, status SUBMITTING) - only one at a time");
                }
            },
            balanceService: { async getSplTokenBalance(){ return { amountRaw: "1000000", decimals: 6, uiAmount: 1 }; } }
        };

        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId), liveOptions);
        const config = tradingBotRepository.getConfig(userId);

        const result = await tm.finalizeClose(position, 0.7, "STOP_LOSS", config);

        assert.equal(result.closed, false);
        assert.equal(result.retrying, true);

        const stillOpen = db.prepare("SELECT status FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(stillOpen.status, "OPEN", "the position must remain OPEN so the very next exit cycle retries it, never silently marked closed on a SELL that never happened");

        const log = db.prepare("SELECT * FROM trading_bot_log WHERE user_id = ? AND log_type = 'ERROR' ORDER BY id DESC LIMIT 1").get(userId);
        assert.ok(log, "the contention failure must leave a real, visible DB trail - not just a console.error swallowed by the scheduler's own top-level catch");
        assert.match(log.message, /could not even start/);
        assert.match(log.message, /already has an active execution/);

    }
    finally{
        deleteTestUser(userId);
    }

});

test("partialClose: a wallet-contention throw from executionService.execute() is caught, logged, and retried at full size", async () => {

    const testEmail = `tradermanager.test.contentionpartial.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestTokenContentionPartial111", tokenSymbol: "CONTENDP", entryPrice: 1.0, sizeUsd: 10,
            confidence: 55, exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 1.5, targetMarketCap: null, stopLossPrice: 0.8, stopLossMarketCap: null
        });
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);

        const liveOptions = {
            userId, walletPublicKey: "FakeWalletContentionPartial111",
            executionService: {
                async execute(){
                    throw new Error("executionService: user already has an active execution (#1, status SUBMITTING) - only one at a time");
                }
            },
            balanceService: { async getSplTokenBalance(){ return { amountRaw: "1000000", decimals: 6, uiAmount: 1 }; } }
        };

        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId), liveOptions);
        const config = tradingBotRepository.getConfig(userId);

        const result = await tm.partialClose(position, 1.25, 0.8, "TP1", config);

        assert.equal(result.closed, false);
        assert.equal(result.retrying, true);

        const stillFullSize = db.prepare("SELECT status, tp1_hit_at FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(stillFullSize.status, "OPEN");
        assert.equal(stillFullSize.tp1_hit_at, null, "TP1 must not be marked hit on a sell that never actually happened");

        const log = db.prepare("SELECT * FROM trading_bot_log WHERE user_id = ? AND log_type = 'ERROR' ORDER BY id DESC LIMIT 1").get(userId);
        assert.ok(log, "the contention failure must leave a real, visible DB trail");
        assert.match(log.message, /could not even start/);

    }
    finally{
        deleteTestUser(userId);
    }

});

// Production trading-quality audit (2026-08-06, Phase 2 - position
// sizing): confidenceLiquiditySizeFactor's own bucket boundaries and
// liquidity scaling, proven directly against the real backtested
// EV-bucket table (see the function's own header comment for the
// underlying n=243 real-trade methodology), not just exercised
// indirectly through openPosition.
test("confidenceLiquiditySizeFactor applies the real backtested EV-bucket table and liquidity scaling", () => {

    const { confidenceLiquiditySizeFactor } = tradeManager;

    // Reference liquidity (15000) keeps liqFactor at exactly 1x, isolating
    // the confidence-bucket behavior.
    assert.equal(confidenceLiquiditySizeFactor(null, 15000), Math.max(0.3, 1 + -0.5 / 22), "missing confidence must fall into the below-floor bucket, never treated as high-quality");
    assert.equal(confidenceLiquiditySizeFactor(40, 15000), Math.max(0.3, 1 + -0.5 / 22), "confidence below 55 (below AGGRESSIVE's own floor) is the worst EV bucket");
    assert.equal(confidenceLiquiditySizeFactor(57, 15000), 1 + 20.0 / 22, "the 55-60 bucket measurably outperformed higher confidence in this account's real history - must size UP, not down");
    assert.equal(confidenceLiquiditySizeFactor(80, 15000), 1 + 5.0 / 22, "60+ is a real, positive, but smaller EV bucket than 55-60");

    // Liquidity scaling: clamped to [0.4, 1.3], linear at liquidity/15000 in between.
    assert.equal(confidenceLiquiditySizeFactor(80, 0), Math.max(0.3, (1 + 5.0 / 22) * 0.4), "near-zero liquidity must floor at the 0.4x liquidity factor, never go to zero");
    assert.equal(confidenceLiquiditySizeFactor(80, 100000), Math.max(0.3, (1 + 5.0 / 22) * 1.3), "very high liquidity must cap at the 1.3x liquidity factor");
    assert.equal(confidenceLiquiditySizeFactor(80, 7500), Math.max(0.3, (1 + 5.0 / 22) * 0.5), "liquidity between the floor/cap must scale linearly at liquidity/15000");

});

// Confirms the quality factor is actually wired into PERCENT-mode
// sizing (openPosition's real call site), and - the specific bug this
// session caught before it ever reached production - that FIXED_USD
// mode stays completely untouched by it, since the backtest only ever
// measured this factor against this account's real percent-of-cash
// trade history, never a Founder-fixed dollar amount.
test("openPosition scales PERCENT-mode size by confidenceLiquiditySizeFactor, but FIXED_USD mode ignores it entirely", async () => {

    const testEmail = `tradermanager.test.sizing.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const baseToken = gmgnTokenRepository.getAllTokens().find(t => t.market_cap > 0 && t.price > 0);
        assert.ok(baseToken);
        // Reference liquidity (15000) keeps liqFactor at exactly 1x, so the
        // expected size is driven purely by the confidence bucket below.
        const token = { ...baseToken, liquidity: 15000 };

        const live = { confidence: 80, risk: "LOW" }; // 60+ bucket: factor = 1 + 5/22

        tradingBotRepository.updateConfig(userId, { position_sizing_mode: "PERCENT", position_size_pct: 10, max_position_size: 1000, min_order_size: 1 });
        const config = tradingBotRepository.getConfig(userId);

        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));
        const result = await tm.openPosition(token, live, config, /* availableCash */ 1000);

        assert.equal(result.opened, true, `expected a real BUY (got: ${JSON.stringify(result)})`);
        const expectedSizeUsd = 1000 * 0.10 * (1 + 5.0 / 22);
        assert.ok(Math.abs(result.sizeUsd - expectedSizeUsd) < 0.01, `PERCENT mode must apply the quality factor on top of the base percent-of-cash amount (expected ~${expectedSizeUsd.toFixed(2)}, got ${result.sizeUsd})`);

    }
    finally{
        deleteTestUser(userId);
    }

});

// Production trading-quality audit (2026-08-06) - real bug found via
// runExitCycle's own end-to-end test suite (tradingBotEngine.test.js),
// not by dynamicExitService.test.js's hand-built fixtures: closeIfDue
// was computing maePctNow (Math.min(position.mae_pct || 0, roiSoFarPct))
// and handing THAT to evaluateDynamicExit as position.mae_pct, so the
// MAE_ACCELERATED_EXIT check (`roiPct <= position.mae_pct`) compared
// this cycle's own low against itself - always true - and fired
// MAE_ACCELERATED_EXIT_NO_SIGNAL on a brand-new position's very FIRST
// losing tick (no real "acceleration" ever happened, no prior real
// drawdown ever existed to expand from). Fixed by leaving mae_pct as
// the position's original, pre-this-cycle value when calling
// evaluateDynamicExit (mfe_pct still correctly uses the fresh
// mfePctNow - MOMENTUM_WEAKENING_EARLY_EXIT genuinely needs the real
// current peak). This proves the fix directly: a fresh position's very
// first negative tick, with no realtime buffer signal at all (the
// exact real-production shape MAE_ACCELERATED_EXIT_NO_SIGNAL exists
// for), must NOT close - there is no established prior low yet to
// have "expanded" from.
test("closeIfDue does NOT fire MAE_ACCELERATED_EXIT_NO_SIGNAL on a brand-new position's very first losing tick", async () => {

    const testEmail = `tradermanager.test.firstdip.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    assert.equal(registerResult.ok, true);
    const userId = registerResult.userId;

    try{

        const positionId = tradingBotRepository.insertPosition(userId, {
            tokenAddress: "TestFirstDipToken111", tokenSymbol: "FDIP",
            entryPrice: 1.0, sizeUsd: 10, confidence: 60,
            exitStrategy: "dynamicExit", engineVersion: "production_v2",
            targetPrice: 999, targetMarketCap: null, stopLossPrice: 0.5, stopLossMarketCap: null
        });
        // Fresh row - mae_pct/mfe_pct both default to 0, exactly like a
        // position that has never been evaluated before.
        const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(position.mae_pct, 0, "test setup: a brand-new position must start with no established mae_pct");

        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));

        // -10% on the very first ever check - well above the real -50%
        // stop-loss floor, and with no realtime pulse buffer data (this
        // is the token's first appearance, nothing has been recorded).
        const token = { token_address: "TestFirstDipToken111", price: 0.90, symbol: "FDIP" };
        const result = await tm.closeIfDue(position, token, config);

        assert.equal(result.closed, false, "a first losing tick with no established prior low must HOLD, never be treated as an 'acceleration' from a low that never existed");

        const stillOpen = db.prepare("SELECT status, mae_pct FROM trading_bot_positions WHERE id = ?").get(positionId);
        assert.equal(stillOpen.status, "OPEN");
        assert.ok(Math.abs(stillOpen.mae_pct - -10) < 0.001, `mae_pct must still be correctly tracked/persisted at ~-10 for future cycles, even though it didn't trigger a close this cycle (got ${stillOpen.mae_pct})`);

    }
    finally{
        deleteTestUser(userId);
    }

});
