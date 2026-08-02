// scripts/validation/task_arjunaV4_roiVerification.js - Arjuna V4
// (Sprint 11), Part 9. Runs 100 SIMULATION-mode open->close trades
// through the REAL tradeManager.js + tradingBotRepository.js (a real,
// temporary user in the real dev DB - deleted at the end, same
// cleanup convention services/tradeManager.test.js already uses), then
// proves the single-source-of-truth claim: every trade's
// realized_roi_pct is what tradingBotService.getTrades() surfaces AND
// what tradingBotRepository.sumClosedTrades()'s own SQL aggregate
// (the Dashboard/Analytics path) sums to - never two different numbers
// for the same trade.
//
// SIMULATION never has a real on-chain swap, so roi_version is always
// 'v1_simulated' and realized_roi_pct falls back to the snapshot
// roi_pct by design (see roiCalculator.js/tradeManager.js) - this
// script proves that fallback is applied IDENTICALLY everywhere, not
// that simulated trades have real SOL data (they never do; the real-SOL
// path is proven separately by tradeManager.test.js's own LIVE
// round-trip test using a mocked executionService).
//
// Usage: node src/scripts/validation/task_arjunaV4_roiVerification.js [count]

const crypto = require("crypto");

const tradeManager = require("../../services/tradeManager");
const tradingBotRepository = require("../../repositories/tradingBotRepository");
const tradingBotService = require("../../services/tradingBotService");
const gmgnTokenRepository = require("../../repositories/gmgnTokenRepository");
const userAuthService = require("../../services/userAuthService");
const db = require("../../database/connection");

const TOTAL = Number(process.argv[2]) || 100;

const REASONS = ["STOP_LOSS", "TP1", "TP2", "TIME_EXIT", "MOMENTUM_HEALTH_EMERGENCY"];

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

async function main(){

    console.log(`=== Arjuna V4 (Sprint 11), Part 9: ${TOTAL} simulated trades - ROI single-source verification ===`);

    const testEmail = `arjunav4.roiverify.${crypto.randomBytes(8).toString("hex")}@example.invalid`;
    const registerResult = userAuthService.register(null, testEmail, "test-password-12345");
    if(!registerResult.ok) throw new Error(`register failed: ${JSON.stringify(registerResult)}`);
    const userId = registerResult.userId;

    let failures = [];

    try{

        const token = gmgnTokenRepository.getAllTokens().find(t => t.market_cap > 0 && t.liquidity > 0 && t.price > 0);
        if(!token) throw new Error("local dev DB must have at least one real priced token for this script to mean anything");

        const live = { confidence: 75, risk: "LOW" };
        const config = tradingBotRepository.getConfig(userId);
        const tm = tradeManager.createTradeManager(tradingBotRepository.forUser(userId));

        const openedTradeIds = [];

        for(let i = 0; i < TOTAL; i++){

            const openResult = await tm.openPosition(token, live, config, /* availableCash */ 100000);
            if(!openResult.opened){
                failures.push(`trade ${i}: openPosition failed - ${openResult.reason}`);
                continue;
            }

            const position = db.prepare("SELECT * FROM trading_bot_positions WHERE id = ?").get(openResult.positionId);

            // Random exit between -40% and +120% of entry - wide enough to
            // cover loss/breakeven/TP-shaped outcomes, cycling through
            // every real close reason tradingBotService.categorizeCloseReason
            // maps.
            const multiplier = 0.6 + Math.random() * 1.6;
            const exitPrice = position.entry_price * multiplier;
            const reason = REASONS[i % REASONS.length];

            const closeResult = await tm.finalizeClose(position, exitPrice, reason, config);
            if(!closeResult.closed){
                failures.push(`trade ${i}: finalizeClose failed - ${JSON.stringify(closeResult)}`);
                continue;
            }

            const tradeRow = db.prepare("SELECT * FROM trading_bot_trades WHERE user_id = ? AND token_address = ? ORDER BY id DESC LIMIT 1").get(userId, token.token_address);
            openedTradeIds.push(tradeRow.id);

            // Part 1: SIMULATION always falls back to the snapshot ratio,
            // honestly tagged - realized_roi_pct must equal roi_pct here,
            // never drift, never be null.
            if(tradeRow.realized_roi_pct == null){
                failures.push(`trade ${i} (id ${tradeRow.id}): realized_roi_pct is null`);
            }
            else if(Math.abs(tradeRow.realized_roi_pct - tradeRow.roi_pct) > 0.1){
                failures.push(`trade ${i} (id ${tradeRow.id}): realized_roi_pct (${tradeRow.realized_roi_pct}) diverges from roi_pct (${tradeRow.roi_pct}) by more than 0.1%`);
            }
            if(tradeRow.roi_version !== "v1_simulated"){
                failures.push(`trade ${i} (id ${tradeRow.id}): roi_version expected 'v1_simulated', got '${tradeRow.roi_version}'`);
            }
            if(tradeRow.dataset_version !== "v2_realized_roi"){
                failures.push(`trade ${i} (id ${tradeRow.id}): dataset_version expected 'v2_realized_roi', got '${tradeRow.dataset_version}'`);
            }

        }

        console.log(`Opened+closed ${openedTradeIds.length}/${TOTAL} trades.`);

        // Part 7: Dashboard/Analytics (getTrades) must read the exact same
        // realized_roi_pct every trade row already has - never a second,
        // independently-computed number. getTrades() doesn't expose `id`
        // in its public shape (Part 11 - additive fields only, no schema
        // change to the response) and CURRENT_TIMESTAMP has only
        // second-resolution (this loop runs many trades per second), so
        // ORDER BY created_at DESC doesn't reproduce insertion order
        // reliably enough to pair by position. exitPrice is a continuous
        // random float per trade (collision odds effectively zero across
        // TOTAL trades) - match on that instead, a stronger correctness
        // check anyway since it ties the service row back to a specific,
        // known trade rather than trusting row order at all.
        const serviceTrades = tradingBotService.getTrades(userId, TOTAL + 10);
        const serviceByExitPrice = new Map(serviceTrades.map(t => [t.exitPrice, t]));

        if(serviceTrades.length !== openedTradeIds.length){
            failures.push(`getTrades() returned ${serviceTrades.length} rows, expected ${openedTradeIds.length}`);
        }

        for(const id of openedTradeIds){
            const dbRow = db.prepare("SELECT * FROM trading_bot_trades WHERE id = ?").get(id);
            const svc = serviceByExitPrice.get(dbRow.exit_price);
            if(!svc){
                failures.push(`trade id ${id}: missing from tradingBotService.getTrades() output (matched by exitPrice)`);
                continue;
            }
            const officialRoi = dbRow.realized_roi_pct ?? dbRow.roi_pct;
            if(Math.abs(svc.roiPct - officialRoi) > 0.1){
                failures.push(`trade id ${id}: getTrades() roiPct (${svc.roiPct}) != DB official ROI (${officialRoi})`);
            }
        }

        // Part 7/8: Dashboard-level aggregate (sumClosedTrades - the exact
        // SQL Portfolio/KPI reads) must match a plain manual sum computed
        // independently from the same rows' realized_roi_pct - proving the
        // Database and Dashboard aggregate paths never diverge.
        const dbAggregate = tradingBotRepository.sumClosedTrades(userId);

        let manualWin = 0, manualLoss = 0, manualPnl = 0;
        for(const id of openedTradeIds){
            const row = db.prepare("SELECT * FROM trading_bot_trades WHERE id = ?").get(id);
            const roi = row.realized_roi_pct ?? row.roi_pct;
            if(roi > 0) manualWin++; else manualLoss++;
            manualPnl += (row.size_usd * roi / 100) - row.fee_usd;
        }

        if(dbAggregate.winCount !== manualWin){
            failures.push(`sumClosedTrades winCount (${dbAggregate.winCount}) != manual winCount (${manualWin})`);
        }
        if(dbAggregate.lossCount !== manualLoss){
            failures.push(`sumClosedTrades lossCount (${dbAggregate.lossCount}) != manual lossCount (${manualLoss})`);
        }
        if(Math.abs(dbAggregate.realizedPnl - manualPnl) > 0.5){
            failures.push(`sumClosedTrades realizedPnl (${dbAggregate.realizedPnl.toFixed(2)}) != manual realizedPnl (${manualPnl.toFixed(2)})`);
        }

        console.log(`Aggregate check: DB winCount=${dbAggregate.winCount} lossCount=${dbAggregate.lossCount} realizedPnl=${dbAggregate.realizedPnl.toFixed(2)}`);
        console.log(`Aggregate check: manual winCount=${manualWin} lossCount=${manualLoss} realizedPnl=${manualPnl.toFixed(2)}`);

    }
    finally{
        deleteTestUser(userId);
    }

    if(failures.length){
        console.log(`\n=== FAILED: ${failures.length} issue(s) ===`);
        for(const f of failures) console.log(` - ${f}`);
        process.exitCode = 1;
    }
    else{
        console.log(`\n=== PASSED: ${TOTAL} simulated trades, realized_roi_pct identical across Database/Dashboard/Analytics (v1_simulated, dataset_version v2_realized_roi) ===`);
    }

}

main().catch(err => {
    console.error("Script crashed:", err);
    process.exitCode = 1;
});
