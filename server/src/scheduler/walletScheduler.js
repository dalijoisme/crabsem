// scheduler/walletScheduler.js - builds the real wallet trade ledger
// from already-collected activity feed data and recomputes wallet
// scores/labels, on its own interval. No GMGN calls happen here at
// all (see walletLedgerService.js) - this only processes data the
// other collectors already brought in, so it costs zero extra API
// quota and can run as often as is useful.

const { buildLedgerFromActivityFeed, registerDevWallets } = require("../services/walletLedgerService");
const { recomputeAllWalletStats } = require("../services/walletIntelligenceService");
const { createLockGuard } = require("../services/schedulerLockGuard");

const INTERVAL_MS = 5 * 60 * 1000;

// SPRINT 12 (Arjuna V5): mandatory lifecycle + watchdog, see
// services/schedulerLockGuard.js's own header.
const lockGuard = createLockGuard("wallet-scheduler", { maxDurationMs: 10 * INTERVAL_MS });

function runOnce(){

    if(!lockGuard.tryAcquire()){

        console.warn("[wallet-scheduler] Skipped: previous run still in progress");

        return null;

    }

    const startedAt = Date.now();

    try{

        const ledgerResult = buildLedgerFromActivityFeed();

        const devResult = registerDevWallets();

        const statsResult = recomputeAllWalletStats();

        const durationMs = Date.now() - startedAt;

        console.log(`[wallet-scheduler] ledger=${JSON.stringify(ledgerResult)} devWallets=${devResult.registered} scored=${statsResult.walletsScored} (${durationMs}ms)`);

        lockGuard.release("FINISHED");

        return { ledgerResult, devResult, statsResult, durationMs };

    }
    catch(err){

        console.error(`[wallet-scheduler] FAILED: ${err.message}`);

        lockGuard.release("ERROR");

        return { ok: false, error: err.message };

    }

}

function start(){

    console.log(`[wallet-scheduler] Starting - building ledger + scoring wallets every ${INTERVAL_MS / 1000}s`);

    runOnce();

    const timer = setInterval(runOnce, INTERVAL_MS);

    return { stop(){ clearInterval(timer); } };

}

module.exports = { start, runOnce, getTickHealth: lockGuard.getHealth };
