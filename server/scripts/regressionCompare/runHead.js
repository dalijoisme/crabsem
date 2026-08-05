// scripts/regressionCompare/runHead.js - Regression Comparator, HEAD
// side. Replays the exact GMGN-facing subset of one BUY cycle - manage
// open positions (refresh gating) + attempt each BUY candidate up to
// (never including) submit - using the REAL, unmodified production
// functions from THIS checkout, against the shared fixture.js input and
// spyGmgnClient.js (no real network calls, no real DB writes, no real
// trade submission).
//
// Scope, stated plainly:
//   - entryGateService/scoring/AI Decision Engine are NOT replayed -
//     confirmed (during the earlier source audit) to make zero GMGN
//     calls, so skipping them changes nothing about the request PATTERN
//     under investigation, and keeps this tool from ever touching AI
//     logic at all, per the explicit constraint this tool was built
//     under.
//   - This measures ONE COLD manageOpenPositions() call - the
//     heldPositionMarketStore (HEAD-only) starts empty, so this run
//     exercises the FALLBACK direct-fetch branch, not the steady-state
//     "usually served from the centralized scheduler's own store" case.
//     That's the correct scope for isolating the gating LOGIC difference
//     under investigation; it is not a steady-state throughput measurement.
//   - Real trading_bot_positions/trading_bot_log DB writes are avoided
//     by stubbing the specific repository functions manageOpenPositions/
//     openPosition call internally (findOpenPositions, insertLog,
//     gmgnTrenchesRepository.findByTokenAddress, tokenLastDecisionRepository.findByToken,
//     decisionEvidenceService.captureDecisionEvidence) - restored after.
//     A real trading_bot_positions row is NEVER written: openPosition's
//     own `repository` parameter is a fully in-memory fake object here,
//     not tradingBotRepository.forUser() - see FAKE_REPOSITORY below.

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
const decisionEvidenceService = require("../../src/services/decisionEvidenceService");

const ENGINE_VERSION = "HEAD";
const telemetry = [];

function stub(obj, method, fn){
    const original = obj[method];
    obj[method] = fn;
    return () => { obj[method] = original; };
}

async function main(){

    const spyClient = createSpyGmgnClient({ telemetry, engineVersion: ENGINE_VERSION });

    // ---- ondemandService fake: routes straight into the spy, bypassing
    // the real gmgnOndemandService's DB-backed cache (that cache would
    // need real DB writes to function - out of scope/forbidden for this
    // tool; bypassing it here does not change the CALLING pattern being
    // measured, only removes a DB-dependent cache layer this comparator
    // was told not to touch). ----
    const ondemandService = {
        getTokenPoolInfo: (chain, address, ttlSeconds) => spyClient.getTokenPoolInfo(chain, address),
        getTokenKline: (chain, address, resolution, ttlSeconds) => spyClient.getTokenKline(chain, address, resolution)
    };

    const restores = [
        stub(tradingBotRepository, "findOpenPositions", () => fixture.HELD_POSITIONS),
        stub(tradingBotRepository, "insertLog", () => {}),
        stub(gmgnTrenchesRepository, "findByTokenAddress", () => null),
        stub(tokenLastDecisionRepository, "findByToken", () => null),
        stub(decisionEvidenceService, "captureDecisionEvidence", () => {})
    ];

    // Fully in-memory - openPosition's own real, documented DI seam (see
    // its header comment: "any object implementing insertPosition(row),
    // updatePositionTracking, closePosition, insertLog - same shape
    // benchmarkRunner.js/abTestEngine.js already use"). No real
    // trading_bot_positions row is ever written.
    const FAKE_REPOSITORY = {
        insertPosition: () => 1,
        updatePositionTracking: () => {},
        closePosition: () => {},
        insertLog: () => {}
    };

    const FAKE_TRADE_MANAGER_FOR_EXIT = { closeIfDue: async () => ({ closed: false }) };

    try{

        // ---- Phase 1: manage open positions (refresh gating) - the
        // REAL, unmodified manageOpenPositions(), byAddress map supplied
        // so the gmgnTokenRepository.getTokenByAddress DB path is never
        // reached. ----
        setOrigin("manage-open-positions");
        await tradingBotEngine.manageOpenPositions(
            fixture.USER_ID, FAKE_TRADE_MANAGER_FOR_EXIT, fixture.BOT_CONFIG,
            fixture.HELD_TOKENS_BY_ADDRESS, ondemandService
        );

        // ---- Phase 2: attempt each BUY candidate, real openPosition(),
        // real convertUsdToLamports, real gmgnSwapTransactionBuilder.build() -
        // stopped synthetically right before submit(). ----
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

                        // Real build() - real quote call(s), real
                        // assertQuoteIsSafeToExecute check. STOPS HERE -
                        // .submit() (the real POST /v1/trade/swap) is
                        // never called. This is the exact "up to but
                        // never including submit" boundary required.
                        await builder.build({ userId, walletPublicKey, action, amountLamports, tokenAddress });

                        return { executionId: null, outcome: "SUCCESS", txHash: "DRY_RUN_NO_SUBMIT", actualAmounts: null };

                    }
                }

            };

            const tm = tradeManager.createTradeManager(FAKE_REPOSITORY, liveOptions);

            try{
                await tm.openPosition(token, live, fixture.BOT_CONFIG, fixture.AVAILABLE_CASH, fixture.USER_ID);
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

    // REGRESSION_OUTPUT_PATH (isolation-test addition): lets this same
    // script be run twice under different config.HELD_POSITION_REFRESH_MODE
    // values without the second run overwriting the first - see
    // runFlagCompare.js, which is the only caller that sets this.
    // Defaults to the original fixed filename so every existing
    // invocation/doc reference is unaffected.
    const outPath = process.env.REGRESSION_OUTPUT_PATH
        ? path.resolve(process.env.REGRESSION_OUTPUT_PATH)
        : path.join(__dirname, "telemetry-head.json");
    fs.writeFileSync(outPath, JSON.stringify({
        engineVersion: ENGINE_VERSION,
        heldPositionRefreshMode: require("../../src/config/env").HELD_POSITION_REFRESH_MODE,
        generatedAt: new Date().toISOString(), telemetry
    }, null, 2));
    console.log(`[regression-compare] HEAD (mode=${require("../../src/config/env").HELD_POSITION_REFRESH_MODE}): ${telemetry.length} recorded GMGN calls -> ${outPath}`);

}

main().catch(err => { console.error("[regression-compare] runHead.js FAILED:", err); process.exitCode = 1; });
