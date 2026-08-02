// scheduler/missedOpportunityOutcomeScheduler.js - Momentum Validation
// System sprint (Sprint 5). Fills in the real "what happened after we
// missed it" outcome for pending rows in trading_bot_missed_opportunity
// (repositories/tradingBotMissedOpportunityRepository.js), once a fixed
// horizon has passed since the skip. Zero new GMGN polling - reads
// token_price_history (migration 006), the same already-collected real
// time series services/benchmarkReportService.js's own hindsight-metrics
// code already reads for the identical question.
//
// Deliberately separate from tradingBotScheduler.js's 15s live-trading
// tick - outcome evaluation is never time-critical the way a real BUY/
// SELL decision is, so this runs on its own, much longer interval,
// following the exact isRunning-guard + setInterval + runOnce() shape
// scheduler/predictionValidationScheduler.js already proves.

const tradingBotMissedOpportunityRepository = require("../repositories/tradingBotMissedOpportunityRepository");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");
const { createLockGuard } = require("../services/schedulerLockGuard");

// Tunable: how long to wait after a miss before checking "what did it do
// afterward". 6 hours gives real memecoin momentum room to play out
// without waiting so long the Founder can't see fresh results.
const OUTCOME_HORIZON_HOURS = 6;

// If STILL no real price-history data exists for a token even this long
// after the skip (e.g. it fell out of the GMGN trending/collection
// scope entirely), stop waiting and record an honest "could not be
// evaluated" (null outcome, but outcome_evaluated_at set) rather than
// leaving the row pending forever - retentionConfig's own 48h
// token_price_history window is the hard ceiling this must stay under.
const MAX_WAIT_HOURS = 24;

const TICK_MS = 15 * 60 * 1000;

// SPRINT 12 (Arjuna V5): mandatory lifecycle + watchdog, see
// services/schedulerLockGuard.js's own header.
const lockGuard = createLockGuard("missed-opportunity-outcome-scheduler", { maxDurationMs: 10 * TICK_MS });

async function runOnce(){

    if(!lockGuard.tryAcquire()){
        console.warn("[missed-opportunity-outcome-scheduler] Skipped: previous run still in progress");
        return null;
    }

    try{

        const pending = tradingBotMissedOpportunityRepository.findPendingOlderThan(OUTCOME_HORIZON_HOURS);
        let evaluated = 0, stillWaiting = 0;

        for(const row of pending){

            const range = tokenPriceHistoryRepository.findRangeForToken(row.token_address, row.skipped_at);

            if(!range.length){
                const ageHours = (Date.now() - new Date(`${String(row.skipped_at).replace(" ", "T")}Z`).getTime()) / 3600000;
                if(ageHours < MAX_WAIT_HOURS){ stillWaiting++; continue; }
                // Genuinely no real data ever showed up - honest null, not a guess.
                tradingBotMissedOpportunityRepository.fillOutcome(row.id, { outcomePrice: null, outcomeReturnPct: null });
                evaluated++;
                continue;
            }

            const peak = Math.max(...range.map(r => Number(r.price)));
            const outcomeReturnPct = row.price_at_skip ? ((peak / row.price_at_skip) - 1) * 100 : null;
            tradingBotMissedOpportunityRepository.fillOutcome(row.id, { outcomePrice: peak, outcomeReturnPct });
            evaluated++;

        }

        console.log(`[missed-opportunity-outcome-scheduler] evaluated=${evaluated} stillWaitingForData=${stillWaiting} of ${pending.length} pending row(s) past the ${OUTCOME_HORIZON_HOURS}h horizon`);

        lockGuard.release("FINISHED");

        return { evaluated, stillWaiting, pendingChecked: pending.length };

    }
    catch(err){

        console.error(`[missed-opportunity-outcome-scheduler] FAILED: ${err.message}`, err);
        lockGuard.release("ERROR");
        return { ok: false, error: err.message };

    }

}

function start(){

    console.log(`[missed-opportunity-outcome-scheduler] Starting - running every ${TICK_MS / 1000}s, evaluating outcomes ${OUTCOME_HORIZON_HOURS}h after each miss`);

    runOnce();

    const timer = setInterval(() => { runOnce().catch(err => console.error("[missed-opportunity-outcome-scheduler] tick FAILED", err)); }, TICK_MS);

    return { stop(){ clearInterval(timer); } };

}

module.exports = { start, runOnce, OUTCOME_HORIZON_HOURS, MAX_WAIT_HOURS, getTickHealth: lockGuard.getHealth };
