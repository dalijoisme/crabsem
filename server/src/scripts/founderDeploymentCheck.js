// scripts/founderDeploymentCheck.js - Finding B deployment verification.
// READ-ONLY: no writes, no tradeManager/executionService calls, no
// network calls. Reports facts only - never opens a position, never
// changes trading_bot_state/config. Safe to run before AND after a
// restart to diff position/trade counts across the deploy.
//
// Run from the server/ directory: node src/scripts/founderDeploymentCheck.js

const fs = require("fs");
const path = require("path");

const config = require("../config/env");
const tradingWalletRepository = require("../repositories/tradingWalletRepository");
const tradingBotRepository = require("../repositories/tradingBotRepository");
const tradingBotService = require("../services/tradingBotService");
const strategyProfileTranslator = require("../services/strategyProfileTranslator");
const db = require("../database/connection");

const SCHEDULER_FILE = path.join(__dirname, "..", "scheduler", "tradingBotScheduler.js");
const FIX_MARKER = "computeLiveByAddressForPhilosophy"; // unique to the Finding B fix - absent before it

function maskKey(key){
    if(!key) return null;
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function main(){

    console.log("=== Finding B deployment check (READ-ONLY - no writes, no execution) ===\n");

    // 1. Is the wiring fix actually present in the deployed file?
    let wiringActive = false;
    try{
        const source = fs.readFileSync(SCHEDULER_FILE, "utf8");
        wiringActive = source.includes(FIX_MARKER);
    }
    catch(e){
        console.log(`[FAIL] Could not read ${SCHEDULER_FILE}: ${e.message}`);
    }
    console.log(`AGGRESSIVE wiring fix present in tradingBotScheduler.js: ${wiringActive ? "YES" : "NO"}`);

    // 2. Founder wallet detection
    if(!config.FOUNDER_WALLET_PUBLIC_KEY){
        console.log("\n[STOP] FOUNDER_WALLET_PUBLIC_KEY is not configured on this environment.");
        process.exit(1);
    }

    const wallets = db.prepare("SELECT user_id, public_key FROM trading_wallets").all();
    const founderWallet = wallets.find(w => w.public_key === config.FOUNDER_WALLET_PUBLIC_KEY);

    if(!founderWallet){
        console.log(`\n[STOP] No trading_wallets row matches FOUNDER_WALLET_PUBLIC_KEY (${maskKey(config.FOUNDER_WALLET_PUBLIC_KEY)}). LIVE mode cannot engage for anyone - founderModeGuard fails closed.`);
        process.exit(1);
    }

    const founderUserId = founderWallet.user_id;
    console.log(`\nFounder wallet detected: user_id=${founderUserId}, public_key=${maskKey(founderWallet.public_key)}`);

    // 3. Bot state - status/mode
    const state = tradingBotRepository.getState(founderUserId);
    console.log(`Bot state: status=${state?.status ?? "NONE"} mode=${state?.mode ?? "NONE"}`);
    if(state?.status === "RUNNING" && state?.mode === "LIVE"){
        console.log("  -> LIVE mode is ARMED. The next scheduler tick can execute a real trade if a candidate clears Entry Gate.");
    }
    else{
        console.log("  -> Not armed (status/mode not RUNNING+LIVE) - restarting the backend cannot trigger a trade on its own.");
    }

    // 4. Strategy profile + translated philosophy
    const botConfig = tradingBotRepository.getConfig(founderUserId);
    console.log(`\nstrategy_profile: ${botConfig.strategy_profile}`);
    const engineParams = strategyProfileTranslator.translate(botConfig);
    console.log(`Translated philosophy carries acceleration override: ${Boolean(engineParams.philosophy.acceleration)}`);

    // 5. Order size (USD) - the exact formula tradeManager.openPosition uses
    const portfolio = tradingBotService.getPortfolio(founderUserId);
    const sizeUsd = Math.min(botConfig.max_position_size, portfolio.availableCash * (botConfig.position_size_pct / 100));
    console.log(`\navailableCash: $${portfolio.availableCash.toFixed(2)}`);
    console.log(`position_size_pct: ${botConfig.position_size_pct}%   max_position_size: $${botConfig.max_position_size}   min_order_size: $${botConfig.min_order_size}`);
    console.log(`==> Computed first order size: $${sizeUsd.toFixed(2)} USD (SOL amount = this ÷ current SOL/USD price - not fetched here, no network call)`);
    if(Math.abs(sizeUsd - 10) > 1){
        console.log(`  -> NOT close to $10 (off by $${(sizeUsd - 10).toFixed(2)}). Adjust position_size_pct or max_position_size before arming LIVE.`);
    }
    else{
        console.log("  -> Within ~$1 of the $10 target.");
    }

    // 6. Only-one-position guarantee
    const openCount = tradingBotRepository.countOpenPositions(founderUserId);
    const cashAfterOneOrder = portfolio.availableCash - sizeUsd;
    const secondOrderBlockedByCash = cashAfterOneOrder < botConfig.min_order_size;
    const secondOrderBlockedByCap = botConfig.max_open_positions <= openCount + 1;
    console.log(`\nmax_open_positions: ${botConfig.max_open_positions}   one_position_per_token: ${botConfig.one_position_per_token}   currently open: ${openCount}`);
    console.log(`After one $${sizeUsd.toFixed(2)} order, remaining cash: $${cashAfterOneOrder.toFixed(2)} (min_order_size $${botConfig.min_order_size})`);
    console.log(`Second position blocked by cash: ${secondOrderBlockedByCash}   blocked by max_open_positions: ${secondOrderBlockedByCap}`);
    if(!secondOrderBlockedByCash && !secondOrderBlockedByCap){
        console.log("  -> [WARNING] Neither guard blocks a second position this cycle. Set max_open_positions=1 for the Founder testing window.");
    }
    else{
        console.log("  -> A second position cannot open this testing window.");
    }

    // 7. Trade/position counts - run this BEFORE and AFTER restart and diff by hand
    const openPositions = tradingBotRepository.findOpenPositions(founderUserId);
    const totalTrades = db.prepare("SELECT COUNT(*) as c FROM trading_bot_trades WHERE user_id = ?").get(founderUserId).c;
    const totalPositionsEver = db.prepare("SELECT COUNT(*) as c FROM trading_bot_positions WHERE user_id = ?").get(founderUserId).c;
    console.log(`\nOpen positions right now: ${openPositions.length}`);
    console.log(`Total trading_bot_trades rows ever (founder): ${totalTrades}`);
    console.log(`Total trading_bot_positions rows ever (founder): ${totalPositionsEver}`);
    console.log("==> Re-run this script after restart. If these two totals are unchanged, no trade was executed.");

    console.log("\n=== end of check - nothing was written ===");

}

main();
