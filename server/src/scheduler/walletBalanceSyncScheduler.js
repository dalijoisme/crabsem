// scheduler/walletBalanceSyncScheduler.js - Production Stabilization V1
// (Sections D/E/Q): keeps trading_bot_config.initial_capital (Trading
// Balance) synced to each user's REAL on-chain wallet balance on a
// timer, for accounts whose dashboard isn't open to trigger
// services/tradingBotService.js's own getTradingConfiguration()
// write-through sync. tradingBotEngine.js's runCycle() hot path
// (getPortfolio()) must stay synchronous/DB-only - a flaky RPC call
// must never stall the trading loop - so this scheduler is the other
// half of keeping that stored value honest without ever making the hot
// path itself RPC-dependent. Never touches runCycle/getPortfolio.
//
// Fails soft PER USER - one account's RPC hiccup is logged and skipped,
// never blocks another account's sync, same convention every other
// per-user loop in this codebase already uses (see
// scheduler/tradingBotScheduler.js's own per-user try/catch).

const tradingWalletRepository = require("../repositories/tradingWalletRepository");
const tradingBotRepository = require("../repositories/tradingBotRepository");
const walletService = require("../services/walletService");
const { computeInitialCapitalFromReal } = require("../services/tradingBotService");

const INTERVAL_MS = 5 * 60 * 1000;

let isRunning = false;

async function runOnce(){

    if(isRunning){
        console.warn("[wallet-balance-sync-scheduler] Skipped: previous run still in progress");
        return null;
    }

    isRunning = true;
    const startedAt = Date.now();
    let synced = 0, skipped = 0, failed = 0;

    try{

        const userIds = tradingWalletRepository.findAllUserIds();

        for(const userId of userIds){

            try{

                const real = await walletService.getRealWalletBalance(userId);
                if(!real || real.solUsd == null){
                    skipped++; // honestly nothing real to sync yet - never fabricate
                    continue;
                }

                const config = tradingBotRepository.getConfig(userId);
                const freshInitialCapital = computeInitialCapitalFromReal(real, config.allocation_pct);
                if(freshInitialCapital !== config.initial_capital){
                    tradingBotRepository.updateInitialCapital(userId, freshInitialCapital);
                }
                synced++;

            }
            catch(err){
                failed++;
                console.error(`[wallet-balance-sync-scheduler] user=${userId} FAILED: ${err.message}`);
            }

        }

        const durationMs = Date.now() - startedAt;
        console.log(`[wallet-balance-sync-scheduler] synced=${synced} skipped=${skipped} failed=${failed} of ${userIds.length} users (${durationMs}ms)`);
        return { synced, skipped, failed, total: userIds.length, durationMs };

    }
    finally{
        isRunning = false;
    }

}

function start(){

    console.log(`[wallet-balance-sync-scheduler] Starting - syncing Trading Balance to real wallet balance every ${INTERVAL_MS / 1000}s`);

    runOnce().catch(err => console.error("[wallet-balance-sync-scheduler] initial run FAILED", err));

    const timer = setInterval(() => { runOnce().catch(err => console.error("[wallet-balance-sync-scheduler] run FAILED", err)); }, INTERVAL_MS);

    return { stop(){ clearInterval(timer); } };

}

module.exports = { start, runOnce };
