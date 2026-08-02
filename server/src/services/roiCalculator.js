// services/roiCalculator.js - Arjuna V4 (Sprint 11), Part 1. THE single
// ROI formula for the entire codebase. Every module that used to inline
// `((exitPrice / entryPrice) - 1) * 100` or
// `((received - spent) / spent) * 100` itself now calls one of the two
// functions below instead - never a second, independently-drifting
// implementation of either formula anywhere.
//
// computeRoiPct: the generic ratio formula - basis vs outcome, unitless
// (works for a price ratio, a market-cap ratio, or an amount ratio,
// since it's the same math either way). Used for anything that is
// ALLOWED to be snapshot/estimate-based - live TP/SL/timer TRIGGER
// decisions (dynamicExitService.js), MFE/MAE tracking, and an OPEN
// position's live unrealized-ROI display (there is no "actual" ROI for
// a position that hasn't sold yet, by definition).
//
// computeRealizedRoi: the OFFICIAL, recorded ROI for a COMPLETED trade -
// real actualSolSpent/actualSolReceived for a LIVE (on-chain) trade, or
// the equivalent simulated spent/received value for a SIMULATION/
// benchmark/ab-test trade (there is no blockchain transaction to read
// for those - the simulated entry/exit value IS the ground truth for a
// paper trade). Every module downstream of a CLOSED trade (Dashboard,
// Trade History, Analytics, Benchmark, Self Learning, Dataset Builder)
// reads the persisted realized_roi_pct this produces - never recomputes
// it from price columns itself.

function computeRoiPct(basis, outcome){
    if(basis == null || outcome == null) return null;
    const basisNum = Number(basis);
    if(!Number.isFinite(basisNum) || basisNum === 0) return null;
    const outcomeNum = Number(outcome);
    if(!Number.isFinite(outcomeNum)) return null;
    return ((outcomeNum - basisNum) / basisNum) * 100;
}

// spent/received: real SOL amounts (LIVE) or simulated value in
// whatever consistent unit the caller is using (SIMULATION/benchmark/
// ab-test - always USD-equivalent value in this codebase). Returns
// { realizedPnl, realizedRoiPct } - both null (never fabricated) when
// spent is missing/non-positive.
function computeRealizedRoi({ spent, received }){
    if(spent == null || received == null) return { realizedPnl: null, realizedRoiPct: null };
    const spentNum = Number(spent);
    const receivedNum = Number(received);
    if(!Number.isFinite(spentNum) || spentNum <= 0 || !Number.isFinite(receivedNum)){
        return { realizedPnl: null, realizedRoiPct: null };
    }
    const realizedPnl = receivedNum - spentNum;
    const realizedRoiPct = computeRoiPct(spentNum, receivedNum);
    return { realizedPnl, realizedRoiPct };
}

module.exports = { computeRoiPct, computeRealizedRoi };
