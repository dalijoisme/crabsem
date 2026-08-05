// scripts/regressionCompare/runBaseline.js - Regression Comparator,
// BASELINE (a0a8759) side. Same shared spyGmgnClient.js/fixture.js as
// runHead.js, same "up to but never including submit" boundary, same
// no-real-DB-writes discipline - adapted only where baseline's own real
// function signatures differ from HEAD's (openPosition takes 4 args, no
// trailing userId - Sprint 15 Phase 3 added that later; no
// decisionEvidenceService existed yet).
//
// This file must be run from WITHIN a git worktree checked out at
// a0a8759 (see this tool's own README section in compare.js's header
// for the exact commands) - it requires baseline's OWN
// ../../src/services/tradingBotEngine.js etc., not HEAD's. Running it
// from the main checkout would just re-run HEAD's code under a
// misleading filename.

const path = require("path");
const fs = require("fs");

const { createSpyGmgnClient, setOrigin } = require("./spyGmgnClient");
const fixture = require("./fixture");

const tradingBotEngine = require("../../src/services/tradingBotEngine");
const tradeManager = require("../../src/services/tradeManager");
const { createGmgnSwapTransactionBuilder } = require("../../src/services/execution/gmgnSwapTransactionBuilder");
const usdToSolConverter = require("../../src/services/execution/usdToSolConverter");

const tradingBotRepository = require("../../src/repositories/tradingBotRepository");
const gmgnTrenchesRepository = require("../../src/repositories/gmgnTrenchesRepository");
const tokenLastDecisionRepository = require("../../src/repositories/tokenLastDecisionRepository");

const ENGINE_VERSION = "Arjuna-a0a8759";
const telemetry = [];

function stub(obj, method, fn){
    const original = obj[method];
    obj[method] = fn;
    return () => { obj[method] = original; };
}

async function main(){

    const spyClient = createSpyGmgnClient({ telemetry, engineVersion: ENGINE_VERSION });

    const ondemandService = {
        getTokenPoolInfo: (chain, address, ttlSeconds) => spyClient.getTokenPoolInfo(chain, address),
        getTokenKline: (chain, address, resolution, ttlSeconds) => spyClient.getTokenKline(chain, address, resolution)
    };

    const restores = [
        stub(tradingBotRepository, "findOpenPositions", () => fixture.HELD_POSITIONS),
        stub(tradingBotRepository, "insertLog", () => {}),
        stub(gmgnTrenchesRepository, "findByTokenAddress", () => null),
        stub(tokenLastDecisionRepository, "findByToken", () => null)
    ];

    const FAKE_REPOSITORY = {
        insertPosition: () => 1,
        updatePositionTracking: () => {},
        closePosition: () => {},
        insertLog: () => {}
    };

    const FAKE_TRADE_MANAGER_FOR_EXIT = { closeIfDue: async () => ({ closed: false }) };

    try{

        setOrigin("manage-open-positions");
        await tradingBotEngine.manageOpenPositions(
            fixture.USER_ID, FAKE_TRADE_MANAGER_FOR_EXIT, fixture.BOT_CONFIG,
            fixture.HELD_TOKENS_BY_ADDRESS, ondemandService
        );

        for(const { token, live } of fixture.BUY_CANDIDATES){

            setOrigin(`buy-candidate:${token.symbol}`);

            const liveOptions = {

                userId: fixture.USER_ID,
                walletPublicKey: fixture.WALLET_PUBLIC_KEY,

                convertUsdToLamports: (usdAmount) =>
                    usdToSolConverter.convertUsdPositionToLamports(spyClient, fixture.WALLET_PUBLIC_KEY, usdAmount),

                executionService: {
                    async execute({ userId, walletPublicKey, action, amountLamports, tokenAddress }){

                        const builder = createGmgnSwapTransactionBuilder({
                            gmgnClient: spyClient,
                            config: { FOUNDER_WALLET_PUBLIC_KEY: fixture.WALLET_PUBLIC_KEY },
                            guardLimits: {}
                        });

                        await builder.build({ userId, walletPublicKey, action, amountLamports, tokenAddress });

                        return { executionId: null, outcome: "SUCCESS", txHash: "DRY_RUN_NO_SUBMIT", actualAmounts: null };

                    }
                }

            };

            // Baseline signature: (token, live, config, availableCash) -
            // no trailing userId (added later, Sprint 15 Phase 3).
            const tm = tradeManager.createTradeManager(FAKE_REPOSITORY, liveOptions);

            try{
                await tm.openPosition(token, live, fixture.BOT_CONFIG, fixture.AVAILABLE_CASH);
            }
            catch(err){
                telemetry.push({
                    timestamp_ms: Date.now(), engine_version: ENGINE_VERSION,
                    call_chain: `buy-candidate:${token.symbol} -> ERROR`,
                    endpoint: "N/A", origin: `buy-candidate:${token.symbol}`, candidate: { address: token.token_address },
                    request_start: Date.now(), request_finish: Date.now(), duration_ms: 0,
                    status: `HARNESS_ERROR: ${err.message}`
                });
            }

        }

    }
    finally{
        restores.forEach(restore => restore());
    }

    const outPath = path.join(__dirname, "telemetry-baseline.json");
    fs.writeFileSync(outPath, JSON.stringify({ engineVersion: ENGINE_VERSION, generatedAt: new Date().toISOString(), telemetry }, null, 2));
    console.log(`[regression-compare] ${ENGINE_VERSION}: ${telemetry.length} recorded GMGN calls -> ${outPath}`);

}

main().catch(err => { console.error("[regression-compare] runBaseline.js FAILED:", err); process.exitCode = 1; });
