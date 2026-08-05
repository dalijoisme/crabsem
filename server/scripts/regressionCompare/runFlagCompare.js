// scripts/regressionCompare/runFlagCompare.js - RATE_LIMIT_BANNED
// investigation, isolation test. Runs the Regression Comparator's HEAD
// harness TWICE against THIS SAME checkout - once with
// config.HELD_POSITION_REFRESH_MODE=PROFIT_ONLY (Arjuna a0a8759's own
// original scope), once with ALL_POSITIONS (current production default,
// unchanged) - each in its own child process (so the frozen config
// object is genuinely re-read fresh each time, no require-cache tricks
// needed), then runs compare.js on the two real results.
//
// No worktree needed for this comparison specifically - both runs use
// the exact same HEAD codebase, differing only in the one flag being
// isolated. This directly tests the question the flag exists to answer:
// does toggling ONLY held-position refresh scope explain the traffic
// difference, without touching anything else (Stop Loss logic included -
// PROFIT_ONLY here is the FULL current codebase with just the refresh
// SCOPE dialed back, not a code revert).

const { execFileSync } = require("child_process");
const path = require("path");

const RUN_HEAD = path.join(__dirname, "runHead.js");
const COMPARE = path.join(__dirname, "compare.js");
const MODE_A_PATH = path.join(__dirname, "telemetry-modeA-profit-only.json");
const MODE_B_PATH = path.join(__dirname, "telemetry-modeB-all-positions.json");

function runMode(mode, outPath){

    console.log(`[regression-compare] Running HEAD harness with HELD_POSITION_REFRESH_MODE=${mode}...`);

    execFileSync(process.execPath, [RUN_HEAD], {
        cwd: path.join(__dirname, "..", ".."),
        env: { ...process.env, HELD_POSITION_REFRESH_MODE: mode, REGRESSION_OUTPUT_PATH: outPath },
        stdio: "inherit"
    });

}

function main(){

    runMode("PROFIT_ONLY", MODE_A_PATH);
    runMode("ALL_POSITIONS", MODE_B_PATH);

    console.log("");
    execFileSync(process.execPath, [COMPARE, MODE_A_PATH, MODE_B_PATH], { stdio: "inherit" });

}

main();
