// collectors/gmgn/requestDiagnostics.js - TEMPORARY diagnostic logging
// for the P0 GMGN IP ban investigation. Purely additive: records the
// real timing/sequence of every outgoing GMGN HTTP request so the
// actual runtime request pattern can be proven from logs before any
// production logic changes. No retry/throttling/behavior change lives
// here - this module only observes and logs.
//
// Hooked into authClient.js's fetchWithTimeout() (the one choke point
// every GMGN request already passes through) and
// scheduler/gmgnTrendingScheduler.js's runOnce() (marks tick
// start/end so requests can be grouped and ordered per tick).
//
// REMOVE once the investigation is closed - this is not permanent
// architecture, per the incident ticket's explicit instruction.
//
// RATE_LIMIT_BANNED investigation, round 2: also records every request
// into gmgnTrafficAccounting.js (WHO called it, not just method+subPath +
// tick position) - same choke point, purely additive.
const gmgnTrafficAccounting = require("./gmgnTrafficAccounting");

let tickCounter = 0;
let currentTickId = null;
let sequenceInTick = 0;

function startTick(){

    tickCounter += 1;
    currentTickId = `tick#${tickCounter}@${new Date().toISOString()}`;
    sequenceInTick = 0;

    return currentTickId;

}

function endTick(){

    currentTickId = null;
    sequenceInTick = 0;

}

function nextSequence(){

    if(currentTickId === null) return { tickId: null, sequence: null };

    sequenceInTick += 1;

    return { tickId: currentTickId, sequence: sequenceInTick };

}

function logRequest({ method, subPath, startedAt, finishedAt, status }){

    const { tickId, sequence } = nextSequence();

    gmgnTrafficAccounting.record({ method, subPath, status });

    console.log("[gmgn-diagnostic]", JSON.stringify({

        ts: new Date(finishedAt).toISOString(),

        tickId,

        sequence,

        method,

        endpoint: subPath,

        startedAtMs: startedAt,

        finishedAtMs: finishedAt,

        durationMs: finishedAt - startedAt,

        status

    }));

}

module.exports = { startTick, endTick, logRequest };
