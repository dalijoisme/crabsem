// scheduler/runGmgnSchedulerOnce.js - runs the scheduled job exactly
// once (same code path the 30s interval calls) and exits. Useful for
// manual verification without leaving a long-running process behind.
// Run with: npm run scheduler:gmgn-once

const { runOnce } = require("./gmgnTrendingScheduler");

async function main(){

    const result = await runOnce();

    process.exitCode = (result && result.ok) ? 0 : 1;

}

main();
