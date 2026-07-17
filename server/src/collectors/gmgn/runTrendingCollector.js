// collectors/gmgn/runTrendingCollector.js - manual entry point.
// Run with: npm run collect:gmgn-trending

const { collectTrending } = require("./trendingCollector");
const { GmgnAuthError } = require("./authClient");

async function main(){

    try{

        const result = await collectTrending();

        console.log("GMGN trending collector finished.");
        console.log(`Snapshot id: ${result.snapshotId}`);
        console.log(`Endpoint: ${result.endpoint}`);
        console.log(`Request params: ${JSON.stringify(result.requestParams)}`);
        console.log(`Raw response size: ${result.rawBytes} bytes`);
        console.log(`Tokens received: ${result.tokensReceived}`);
        console.log(`Tokens upserted: ${result.tokensUpserted}`);

        process.exitCode = 0;

    }
    catch(err){

        if(err instanceof GmgnAuthError){

            console.error("GMGN collector stopped: authentication/request failed (not guessing).");

        }
        else{

            console.error("GMGN collector stopped:");

        }

        console.error(err.message);

        process.exitCode = 1;

    }

}

main();
