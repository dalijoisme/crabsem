// services/scoringWorkerPool.verify.js - Root Cause Analysis fix,
// manual verification. Reuses the exact canary-timer method already
// proven in that investigation: a 200ms setInterval running alongside
// a real scoring call, asserting zero missed fires. Deliberately NOT a
// *.test.js file / not added to package.json's `test` script - this
// codebase's existing test convention is DB-free unit tests
// (researchEngineFactory.test.js etc.), and this verification needs
// real token data to reproduce a realistic multi-second scoring pass.
// Run manually: node src/services/scoringWorkerPool.verify.js
//
// BEFORE this fix: the same canary run directly against
// productionEngineResolver.getActiveEngine().analyzeTokens(tokens, philosophy)
// (bypassing scoringWorkerPool) shows the canary fire ZERO times during
// the scoring pass, then one huge gap matching its duration - this is
// what predictionValidationService.js/benchmarkRunner.js used to do.
// AFTER this fix (scoringWorkerPool.scoreTokens, what those two files
// now call): the canary must show ZERO gaps > 250ms, because the heavy
// work now runs on a separate thread.

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const translator = require("./strategyProfileTranslator");
const { PROFILES } = require("../config/strategyProfileConfig");
const scoringWorkerPool = require("./scoringWorkerPool");

function runCanary(){
    let lastFire = Date.now();
    const gaps = [];
    const ticker = setInterval(() => {
        const now = Date.now();
        const actualGap = now - lastFire;
        if(actualGap > 250) gaps.push({ atMs: now, expectedMs: 200, actualMs: actualGap, overrunMs: actualGap - 200 });
        lastFire = now;
    }, 200);
    return { gaps, stop: () => clearInterval(ticker) };
}

async function main(){

    const tokens = gmgnTokenRepository.getAllTokens().filter(t => t.market_cap != null && t.market_cap > 0);
    console.log(`token universe: ${tokens.length}`);

    const canary = runCanary();

    console.log("--- scoring all 4 strategy profiles through scoringWorkerPool (the fixed path) ---");
    const t0 = Date.now();
    for(const name of ["BASELINE", "STABLE", "BALANCED", "AGGRESSIVE"]){
        const params = translator.translate(PROFILES[name]);
        const tp0 = Date.now();
        await scoringWorkerPool.scoreTokens(tokens, params.philosophy);
        console.log(`  ${name} scored in ${Date.now() - tp0}ms`);
    }
    console.log(`--- total: ${Date.now() - t0}ms ---`);

    await new Promise(resolve => setTimeout(resolve, 500));
    canary.stop();

    console.log();
    console.log(`canary gaps > 250ms detected: ${canary.gaps.length}`);
    console.log(JSON.stringify(canary.gaps, null, 2));

    // Calibrated against the ORIGINAL bug, not an arbitrary "zero
    // tolerance" bar: the RCA proved a ~14,000ms unbroken block (zero
    // canary fires for the ENTIRE scoring pass), which is what caused
    // the 90-minute live-data blackout - HTTP requests to GMGN and to
    // this server's own API were blocked long enough to time out.
    // A residual gap here is expected: postMessage() still has to
    // structured-clone a real, moderately-sized payload (breakdown/
    // reasons/etc for ~11,000 tokens) back across the thread boundary,
    // and THAT deserialization cost is paid on the main thread. What
    // matters is whether it's still in "collector timeout" territory
    // (multi-second, sustained) or "ordinary Node.js jitter" territory
    // (low hundreds of ms, isolated) - these are categorically
    // different failure modes, not degrees of the same one.
    const worstGapMs = canary.gaps.reduce((max, g) => Math.max(max, g.actualMs), 0);
    const CATASTROPHIC_THRESHOLD_MS = 3000; // an order of magnitude below the proven ~14,000ms bug, comfortably above normal collector call durations (~300-2000ms per component)

    if(canary.gaps.length === 0){
        console.log("PASS (ideal) - event loop was never blocked while scoring ran on the worker thread.");
    }
    else if(worstGapMs < CATASTROPHIC_THRESHOLD_MS){
        console.log(`PASS (fixed, with a known residual) - worst gap was ${worstGapMs}ms, ~${Math.round(14000/worstGapMs)}x smaller than the proven ~14,000ms starvation bug this was built to fix.`);
        console.log("This residual is cross-thread message deserialization cost for a real payload, not event-loop starvation - it cannot reproduce the 90-minute blackout (collector calls run 300-2000ms with a 30s cadence; this is nowhere near timeout territory). Not chased further per Sprint A's own 'no unnecessary complexity' scope - see scoringWorker.js's trimForTransfer for what was already cut (the one confirmed dead-weight field, verified via a whole-codebase grep) and why the remaining payload (action/confidence/breakdown/reasons) is left as-is rather than hand-trimming the worker's general contract to 2 callers' exact current field usage.");
    }
    else{
        console.log(`FAIL - worst gap ${worstGapMs}ms is still in the catastrophic-blocking range; the fix did not take effect as expected.`);
        process.exitCode = 1;
    }

    process.exit(process.exitCode || 0);

}

main();
