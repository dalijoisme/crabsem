// services/tradeManager.js - CRAB Trading Bot Constitution v1.0, Final
// Specification section 04/08 (Trade Manager Design). Extracted from
// tradingBotEngine.js: this file owns POSITION LIFECYCLE only (open,
// track, close) - it never scores a token, never decides BUY/REJECT
// (that's entryGateService.js's job), and never reads Strategy Profile/
// Opportunity Priority/EMI directly. It is handed an already-eligible
// token (for opening) or an already-open position (for closing) and
// real, already-computed engine output - nothing here is a new metric.
//
// DYNAMIC EXIT WIRING (Final Spec section 01/08): every position closes
// via dynamicExitService.evaluateDynamicExit - TP15 is a MINIMUM target,
// not a ceiling, exactly as approved in the Constitution background and
// already validated in services/abTestEngine.js. The Quality Gate rug
// re-check runs first, unchanged priority.
//
// REPOSITORY PARAMETERIZATION (Benchmark Harness Architecture section 3):
// createTradeManager(repository) takes any object implementing
// insertPosition/updatePositionTracking/closePosition/insertLog - so the
// live bot (bound to tradingBotRepository, see the default export below,
// unchanged behavior) and the Benchmark Harness (bound to a per-participant
// scoped benchmarkPositionRepository) call the exact same open/close
// logic, never two copies of it.
//
// REAL EXECUTION (Sprint 2, Founder Decision - Path A): a second,
// OPTIONAL constructor argument, liveOptions. Omitted (the default, and
// every existing caller - benchmarkRunner.js, abTestEngine.js,
// tradingBotEngine.js's own SIMULATION-mode path) reproduces this
// file's exact pre-Sprint-2 behavior, byte for byte - open/close only
// ever write virtual rows. When liveOptions is provided (ONLY by
// tradingBotEngine.js, and only for the configured Founder Trading
// Wallet - see founderModeGuard.js/config.FOUNDER_WALLET_PUBLIC_KEY),
// openPosition/finalizeClose call executionService.execute() first and
// only write a real row once GMGN's real, confirmed outcome comes back
// SUCCESS. Both functions are async either way now - the simulated path
// simply never awaits anything real.

const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const tokenLastDecisionRepository = require("../repositories/tokenLastDecisionRepository");
const qualityGateService = require("./qualityGateService");
const productionEngineResolver = require("./productionEngineResolver");
const dynamicExitService = require("./dynamicExitService");

const FEE_PCT_DEFAULT = 1;

/**
 * @typedef {object} LiveExecutionOptions
 * @property {ReturnType<import("./execution/executionService").createExecutionService>} executionService
 * @property {ReturnType<import("./execution/balanceValidationService").createBalanceValidationService>} balanceService - used at SELL time to read the REAL on-chain token balance, never a re-derived USD estimate
 * @property {number} userId
 * @property {string} walletPublicKey
 * @property {(usdAmount: number) => Promise<{ lamports: number, solUsdPrice: number }>} convertUsdToLamports
 */

// repository: any object implementing insertPosition(row),
// updatePositionTracking(id, {...}), closePosition(position, {...}),
// insertLog({...}) - tradingBotRepository already does; a benchmark
// participant's scoped repository implements the same shape.
//
// liveOptions: see LiveExecutionOptions above. Optional - omit for
// every simulated/benchmark/ab-test context.
function createTradeManager(repository, liveOptions = null){

    async function openPosition(token, live, config, availableCash){

        const sizeUsd = Math.min(
            config.max_position_size,
            availableCash * (config.position_size_pct / 100)
        );

        if(sizeUsd < config.min_order_size) return { opened: false, reason: "INSUFFICIENT_AVAILABLE_CASH" };

        const entryPrice = Number(token.price) || null;
        if(!entryPrice || entryPrice <= 0) return { opened: false, reason: "NO_REAL_PRICE" };

        const activeVersion = productionEngineResolver.getActiveVersion();
        const activeEngine = productionEngineResolver.getActiveEngine();

        const last = tokenLastDecisionRepository.findByToken(token.token_address);

        // Real, last-recorded participant score from the decision log -
        // never re-scored here - just enough shape for buildRiskBands()'s
        // native formula (see tradePlanService.js).
        const signalStub = {
            participantScore: last?.last_participant_score ?? 50,
            risk: live.risk,
            confidence: live.confidence
        };

        const riskBands = activeEngine.buildRiskBands(token, signalStub, config.exitOverrides);

        if(!riskBands) return { opened: false, reason: "NO_RISK_BANDS_AVAILABLE" };

        // ---- Real execution (Founder Trading Wallet only) - see this
        // file's header. A failed/timed-out real BUY means NO position
        // row is ever written - the founder's capital either moved for
        // real and confirmed, or nothing here pretends it did. ----
        let executionId = null;

        if(liveOptions){

            const { lamports } = await liveOptions.convertUsdToLamports(sizeUsd);

            const result = await liveOptions.executionService.execute({
                userId: liveOptions.userId,
                walletPublicKey: liveOptions.walletPublicKey,
                action: "BUY",
                amountLamports: lamports,
                tokenAddress: token.token_address
            });

            if(result.outcome !== "SUCCESS"){
                return { opened: false, reason: `EXECUTION_${result.outcome}` };
            }

            executionId = result.executionId;

        }

        const positionId = repository.insertPosition({
            tokenAddress: token.token_address,
            tokenSymbol: token.symbol,
            entryPrice,
            sizeUsd,
            confidence: live.confidence,
            exitStrategy: "dynamicExit",
            engineVersion: activeVersion,
            targetPrice: riskBands.target.price,
            targetMarketCap: riskBands.target.marketCap,
            stopLossPrice: riskBands.stopLoss.price,
            stopLossMarketCap: riskBands.stopLoss.marketCap,
            lastVolume1h: token.volume_1h != null ? Number(token.volume_1h) : null,
            executionId
        });

        const kind = executionId ? "Real" : "Virtual";
        repository.insertLog({
            logType: "BUY",
            tokenSymbol: token.symbol,
            message: `${kind} BUY ${token.symbol} @ $${entryPrice} (confidence ${live.confidence}%, size $${sizeUsd.toFixed(2)})${executionId ? ` [execution #${executionId}]` : ""}`,
            meta: { tokenAddress: token.token_address, positionId, confidence: live.confidence, risk: live.risk, sizeUsd, executionId }
        });

        return { opened: true, positionId, sizeUsd };

    }

    async function finalizeClose(position, exitPrice, reason, config){

        const roiPct = ((exitPrice / position.entry_price) - 1) * 100;
        const feeUsd = position.size_usd * ((config.fee_pct || FEE_PCT_DEFAULT) / 100) * 2; // entry + exit
        const durationSeconds = Math.round((Date.now() - new Date(`${String(position.opened_at).replace(" ", "T")}Z`).getTime()) / 1000);

        // ---- Real execution (Founder Trading Wallet only). Selling the
        // REAL on-chain token balance, not a re-derived USD estimate -
        // real balance query, real quantity, exactly what's actually
        // held. A failed/timed-out real SELL leaves the position OPEN -
        // it is picked up again next cycle, never silently marked closed
        // on a trade that didn't really happen. ----
        let closeExecutionId = null;
        let txHash = null;

        if(liveOptions){

            const balance = await liveOptions.balanceService.getSplTokenBalance(liveOptions.walletPublicKey, position.token_address);
            const sellAmountBaseUnits = Number(balance.amountRaw);

            if(!sellAmountBaseUnits || sellAmountBaseUnits <= 0){
                // Nothing real to sell (already sold, dust, or a stale
                // position from before real execution existed) - close
                // the row so it stops being retried, but never claim a
                // real trade that didn't happen.
                repository.closePosition(position, { exitPrice, roiPct: 0, feeUsd: 0, slippagePct: 0, durationSeconds, reason: `${reason}_NO_REAL_BALANCE` });
                repository.insertLog({
                    logType: "SELL", tokenSymbol: position.token_symbol,
                    message: `Position closed with no real on-chain balance to sell (${position.token_symbol}) - reason: ${reason}`,
                    meta: { tokenAddress: position.token_address, reason }
                });
                return { closed: true, reason: `${reason}_NO_REAL_BALANCE`, roiPct: 0 };
            }

            const result = await liveOptions.executionService.execute({
                userId: liveOptions.userId,
                walletPublicKey: liveOptions.walletPublicKey,
                action: "SELL",
                amountLamports: sellAmountBaseUnits,
                tokenAddress: position.token_address
            });

            if(result.outcome !== "SUCCESS"){
                // Position stays OPEN - closeIfDue() will re-evaluate and
                // retry next cycle. Log the attempt for visibility.
                repository.insertLog({
                    logType: "ERROR", tokenSymbol: position.token_symbol,
                    message: `Real SELL attempt for ${position.token_symbol} did not succeed (${result.outcome}) - position remains open, will retry`,
                    meta: { tokenAddress: position.token_address, executionId: result.executionId, outcome: result.outcome }
                });
                return { closed: false, retrying: true };
            }

            closeExecutionId = result.executionId;

        }

        repository.closePosition(position, {

            exitPrice, roiPct, feeUsd,
            slippagePct: config.slippage_pct || 0,
            durationSeconds, reason,
            txHash, closeExecutionId

        });

        const kind = closeExecutionId ? "Real" : "Virtual";
        repository.insertLog({
            logType: "SELL",
            tokenSymbol: position.token_symbol,
            message: `${kind} SELL ${position.token_symbol} @ $${exitPrice} - ${reason} (${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(2)}%)${closeExecutionId ? ` [execution #${closeExecutionId}]` : ""}`,
            meta: { tokenAddress: position.token_address, reason, roiPct, feeUsd, closeExecutionId }
        });

        return { closed: true, reason, roiPct };

    }

    async function closeIfDue(position, token, config){

        const currentPriceNow = Number(token.price) || position.current_price || position.entry_price;
        const roiSoFarPct = ((currentPriceNow / position.entry_price) - 1) * 100;
        const mfePctNow = Math.max(position.mfe_pct || 0, roiSoFarPct);
        const maePctNow = Math.min(position.mae_pct || 0, roiSoFarPct);
        const volume1hNow = token.volume_1h != null ? Number(token.volume_1h) : position.last_volume_1h;

        repository.updatePositionTracking(position.id, {
            currentPrice: currentPriceNow, mfePct: mfePctNow, maePct: maePctNow, lastVolume1h: volume1hNow
        });

        // Re-verify the Quality Gate on every held position, every cycle -
        // a rug that manifests as a rug-ratio/holder-concentration spike
        // WHILE HELD is closed immediately, regardless of what Dynamic
        // Exit's own momentum/reversal reasoning would otherwise say.
        const quality = qualityGateService.passesQualityGate(token, config.qualityGateOverrides);
        if(!quality.pass){
            return finalizeClose(position, currentPriceNow, `RUG_DETECTED_${quality.reason}`, config);
        }

        // Dynamic Exit (Constitution background: validated, retained). Same
        // real engine call, same real trenches lookup, same rule already
        // proven in services/abTestEngine.js - not a copy of that file's
        // code, the SAME shared module. philosophy override (if any) keeps
        // this re-check consistent with whichever profile originally opened
        // the position - the REVERSAL check is re-evaluated the same way it
        // was scored, not on a different profile's terms.
        const trenchesEntry = gmgnTrenchesRepository.findByTokenAddress(token.token_address);
        const freshSignal = productionEngineResolver.getActiveEngine().analyzeToken(token, null, config.philosophy);

        const result = dynamicExitService.evaluateDynamicExit({
            position: { ...position, last_volume_1h: volume1hNow },
            token, trenchesEntry,
            engineAction: freshSignal.action,
            stopLossPrice: position.stop_loss_price,
            minTpPct: config.exitOverrides?.fixedTpPct,
            buyerDominanceRatio: config.exitOverrides?.momentumWeakeningBuyerDominanceRatio
        });

        if(!result.shouldClose) return { closed: false };

        return finalizeClose(position, result.currentPrice, result.reason, config);

    }

    return { openPosition, closeIfDue, finalizeClose };

}

// Sprint A, Goal 2 (auth/multi-tenancy foundation): the old default
// instance bound directly to the raw tradingBotRepository module is
// removed - that module's functions now all take a leading userId
// (repository/tradingBotRepository.js), so a single global binding no
// longer means anything. services/tradingBotEngine.js now calls
// createTradeManager(tradingBotRepository.forUser(userId)) per user,
// per cycle - the exact same factory every other caller
// (benchmarkRunner.js, benchmarkRunService.js) already used.

module.exports = { createTradeManager };
