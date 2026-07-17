// scheduler/runGmgnScheduler.js - long-running entry point that
// collects GMGN trending data every 30 seconds until stopped.
// Run with: npm run scheduler:gmgn (Ctrl+C to stop)

const gmgnTrendingScheduler = require("./gmgnTrendingScheduler");

const handle = gmgnTrendingScheduler.start();

process.on("SIGINT", () => {

    console.log("\n[gmgn-scheduler] Stopping...");

    handle.stop();

    process.exitCode = 0;

});
