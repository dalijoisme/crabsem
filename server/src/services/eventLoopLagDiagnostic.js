// services/eventLoopLagDiagnostic.js - TEMPORARY (validation-scheduler
// stall investigation, 2026-08-06). Uses perf_hooks' own event-loop
// delay histogram to log real event-loop responsiveness on a fixed
// interval, so a period of genuine main-thread blocking - regardless
// of which function actually causes it - shows up as a real, measured
// max/p99 delay spike, correlatable against
// recommendationLoggerService's own wall/CPU timing logs and
// gmgn_tokens/Filtering staleness. Purely observational: starts a
// histogram, logs + resets it periodically, touches no application
// logic, no return values, no control flow anywhere else. Remove once
// the investigation concludes.
const { monitorEventLoopDelay } = require("node:perf_hooks");

const SAMPLE_INTERVAL_MS = 15000;

function start(){

    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();

    const timer = setInterval(() => {

        console.log(`[event-loop-lag-diag] min=${(histogram.min / 1e6).toFixed(1)}ms max=${(histogram.max / 1e6).toFixed(1)}ms mean=${(histogram.mean / 1e6).toFixed(1)}ms p99=${(histogram.percentile(99) / 1e6).toFixed(1)}ms`);

        histogram.reset();

    }, SAMPLE_INTERVAL_MS);

    // Never keep the process alive on its own - a diagnostic must never
    // change shutdown behavior.
    timer.unref();

    return {
        stop(){
            clearInterval(timer);
            histogram.disable();
        }
    };

}

module.exports = { start };
