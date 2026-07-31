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
const { resolveTokenAgeMinutes } = require("./emiService");

const FEE_PCT_DEFAULT = 1;

// Production Stabilization V2 (Close Remaining BUY Blind Spots, Section
// 5 - Position Snapshot): breakdown_json already persisted every
// derived SCORE (participant/market breakdown), but never the raw,
// underlying FACTS those scores were computed from (real rug ratio,
// real developer balance rate, real sniper hold rate, etc. - all
// already fetched, already real, just never written down). Without
// this, a future replay against a changed scoringConfig.js could only
// ever re-derive the SAME old score, never genuinely recompute a new
// one - not a true replay. token: the real gmgn_tokens row (already
// has liquidity/market_cap/holders). trenchesEntry: the same real
// gmgn_trenches row already fetched once for tokenAgeMinutesAtEntry,
// reused here rather than re-fetched.
function buildRawFactsSnapshot(token, trenchesEntry){
    let raw = {};
    try{ raw = trenchesEntry?.raw_json ? JSON.parse(trenchesEntry.raw_json) : {}; }
    catch(e){ /* malformed - honest empty, never guessed */ }
    return {
        liquidity: token.liquidity != null ? Number(token.liquidity) : null,
        marketCap: token.market_cap != null ? Number(token.market_cap) : null,
        holders: token.holders != null ? Number(token.holders) : null,
        volume1h: token.volume_1h != null ? Number(token.volume_1h) : null,
        priceChange1h: token.price_change_1h != null ? Number(token.price_change_1h) : null,
        priceChange5m: token.price_change_5m != null ? Number(token.price_change_5m) : null,
        rugRatio: trenchesEntry?.rug_ratio ?? null,
        top10HolderRate: trenchesEntry?.top_10_holder_rate ?? null,
        smartDegenCount: trenchesEntry?.smart_degen_count ?? null,
        sniperCount: trenchesEntry?.sniper_count ?? null,
        netBuy24h: trenchesEntry?.net_buy_24h ?? null,
        isHoneypot: trenchesEntry?.is_honeypot ?? null,
        developerBalanceRate: raw.creator_balance_rate ?? null,
        sniperHoldRate: raw.top70_sniper_hold_rate ?? null,
        bundlerMhr: raw.bundler_mhr ?? null,
        insiderHoldRate: raw.suspected_insider_hold_rate ?? null,
        creatorCreatedCount: raw.creator_created_count ?? null,
        creatorCreatedOpenRatio: raw.creator_created_open_ratio ?? null
    };
}

// False Positive Reduction V2, Priority 5 (observability): "alasan akhir
// mengapa token tetap lolos" - a plain-language narrative built entirely
// from real, already-known values at the moment of BUY (live.* /
// config.min_confidence), never a new computation or a guess. Every
// clause states a real fact the entry gate/scoring pass already
// established before openPosition() was ever called.
function buildPassReason(live, config){
    const parts = [
        `Action tier ${live.action} at participantScore ${live.participantScore}/${live.participantMax}.`,
        `Confidence ${live.confidence} (floor ${config.min_confidence}).`,
        `Risk classified ${live.risk || "LOW"} (HIGH is hard-rejected before a BUY can ever reach this point).`
    ];
    if(live.missingEvidence?.length){
        parts.push(`Evidence not available for this token: ${live.missingEvidence.join(", ")}.`);
    }
    if(live.riskReasons?.length){
        parts.push(`Real risk flags noted but not disqualifying on their own: ${live.riskReasons.join("; ")}.`);
    }
    return parts.join(" ");
}

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

        // Trading Configuration sprint: position sizing is now a Founder-
        // controlled money-management choice, independent of strategy
        // profile (see services/tradingBotService.js's PROFILE_OWNED_FIELDS/
        // updateTradingConfiguration) - percent-of-balance (the original,
        // still the default) or a fixed USD amount. Either way, still
        // capped by the same real max_position_size ceiling and floored by
        // the same real min_order_size check below - nothing about WHICH
        // token gets bought or WHEN changes, only how much.
        const rawSizeUsd = config.position_sizing_mode === "FIXED_USD"
            ? config.fixed_position_size_usd
            : availableCash * (config.position_size_pct / 100);

        const sizeUsd = Math.min(config.max_position_size, rawSizeUsd);

        if(sizeUsd < config.min_order_size) return { opened: false, reason: "INSUFFICIENT_AVAILABLE_CASH" };

        const entryPrice = Number(token.price) || null;
        if(!entryPrice || entryPrice <= 0) return { opened: false, reason: "NO_REAL_PRICE" };

        // False Positive Reduction V4 (observability, not a gate): real
        // token age at the moment of BUY, now meaningful for the first
        // time since tokenTransformer.js's launch_time fix (GMGN's real
        // open_timestamp:0 "unknown" sentinel was previously read as a
        // literal 1970 date). Persisted, never acted on here - this
        // sprint found a striking real pattern (this account's 4 real
        // losers were all bought within 17-31 minutes of launch; its one
        // real winner was bought 7 days after launch) but explicitly
        // declined to gate on it: age and token size are confounded in
        // this n=5 sample, and picking an age cutoff now would be
        // exactly the small-sample overfitting this sprint was told not
        // to do. Recorded so a future sprint has real data to test this
        // properly once more real outcomes exist.
        const trenchesEntryAtEntry = gmgnTrenchesRepository.findByTokenAddress(token.token_address);
        const tokenAgeMinutesAtEntry = resolveTokenAgeMinutes(token, trenchesEntryAtEntry);
        const rawFactsAtEntry = buildRawFactsSnapshot(token, trenchesEntryAtEntry);

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

        // Trust/UX sprint: real, already-computed decision evidence for
        // this exact BUY - persisted once, here, so a position can
        // explain itself later (position-detail view) without ever
        // re-scoring or guessing. `live.breakdown` is only ever present
        // when the scheduler's own liveMap carried it through (every
        // profile today) - null for any caller whose signal stub never
        // set it (benchmark/ab-test), same optional-with-null-default
        // pattern as `acceleration` above.
        //
        // Live Decision Center / Signal Center sprint: riskReasons/
        // freshnessPenalty folded into the same blob - both already in
        // `live` by this point (scheduler carries them through
        // unmodified), needed so Confidence/Risk Breakdown can be
        // reconstructed later without re-scoring.
        const breakdownJson = live.breakdown
            ? JSON.stringify({
                breakdown: live.breakdown, reasons: live.reasons || [], acceleration: live.acceleration ?? null,
                riskReasons: live.riskReasons || [], freshnessPenalty: live.freshnessPenalty ?? null,
                // Live Decision Center / Signal Center sprint: the real
                // aggregate scores/denominators behind `confidence` -
                // already computed to produce it, never persisted before -
                // so Position Detail's Confidence Breakdown can recompute
                // participantPct/marketPct later without re-scoring.
                participantScore: live.participantScore ?? null, participantMax: live.participantMax ?? null,
                marketHealth: live.marketHealth ?? null, marketHealthMax: live.marketHealthMax ?? null,
                // False Positive Reduction V2, Priority 5: the full,
                // persisted evidence picture for this exact real BUY -
                // positive (`reasons` above), negative (`riskReasons`
                // above), missing (`missingEvidence`), every penalty that
                // shaped `confidence` (`confidenceBreakdown` - mismatch/
                // completeness/freshness/risk, researchEngineFactory.js's
                // computeConfidence), and a plain-language narrative of
                // why this exact token still passed every gate it needed
                // to. All real, already-computed fields carried through on
                // `live` unmodified - nothing here is a new score.
                missingEvidence: live.missingEvidence || [],
                confidenceBreakdown: live.confidenceBreakdown ?? null,
                passReason: buildPassReason(live, config),
                // Production Stabilization Final, Section G/H: the entry
                // gate's own real result (isReentry, marketAgeSeconds,
                // decayFraction) - see tradingBotEngine.js's runCycle,
                // attached onto `live` right before this call. Was
                // computed then discarded before this fix.
                entryGateResult: live.entryGateResult ?? null,
                // False Positive Reduction V4: real token age at entry,
                // observability only - see the comment above where this
                // is computed.
                tokenAgeMinutesAtEntry,
                // Production Stabilization V2 (Close Remaining BUY Blind
                // Spots, Section 5): the real, raw facts every score
                // above was actually computed from - see
                // buildRawFactsSnapshot's own header comment.
                rawFactsAtEntry
            })
            : null;

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
            executionId,
            breakdownJson,
            // Live Decision Center sprint: this cycle's own real
            // Opportunity Priority rank (tradingBotEngine.js's
            // orderCandidates), attached onto `live` right before this
            // function was called - undefined (persisted as null, never
            // a fabricated 0) whenever Opportunity Priority is off.
            rankAtEntry: live.rankAtEntry ?? null,
            priorityScoreAtEntry: live.priorityScoreAtEntry ?? null,
            risk: live.risk ?? null,
            // Momentum Validation System sprint (Self-Comparison): this
            // cycle's other real ranked BUY-tier candidates, attached onto
            // `live` right before this function was called - purely
            // observational (never read back into ranking/scoring), null
            // whenever Opportunity Priority was off or no other candidate
            // existed this cycle.
            siblingsJson: live.siblings?.length ? JSON.stringify(live.siblings) : null,
            // Production Stabilization V1: the real trading_bot_config row
            // this exact BUY decision was made under (strategy_profile,
            // min_confidence, quality gate/exit overrides, sizing mode -
            // everything) - a later profile switch or Trading Configuration
            // edit can never erase what was actually active at decision
            // time. `config` here is always a plain, already-loaded DB row
            // (tradingBotRepository.getConfig's own shape) for the real
            // bot; a benchmark/ab-test caller's own lighter config object
            // serializes the same way, honestly reflecting what it really
            // used.
            configSnapshotJson: JSON.stringify(config)
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

    // options.skipBalanceCheck (Trust/UX sprint): set only by
    // closeIfDue()'s own external-sell detection below, which has
    // ALREADY confirmed the real balance is zero this exact cycle -
    // skips straight past the balance-check + real-SELL-execution
    // branch (there is nothing left to sell, and no real execution to
    // attribute this close to; the sell already happened outside CRAB
    // entirely) and closes with `reason` verbatim, never the
    // `_NO_REAL_BALANCE` suffix reserved for "we decided to sell but
    // there was nothing there," a different, pre-existing case just
    // below.
    async function finalizeClose(position, exitPrice, reason, config, options = {}){

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

        if(liveOptions && !options.skipBalanceCheck){

            const balance = await liveOptions.balanceService.getSplTokenBalance(liveOptions.walletPublicKey, position.token_address);
            const sellAmountBaseUnits = Number(balance.amountRaw);

            if(!sellAmountBaseUnits || sellAmountBaseUnits <= 0){
                // Nothing real to sell (already sold, dust, or a stale
                // position from before real execution existed) - close
                // the row so it stops being retried, but never claim a
                // real trade that didn't happen.
                //
                // Production Stabilization V1 Final Sprint (Section I):
                // closePosition() is now the real idempotency guard - if
                // a concurrent caller (the scheduler's own automatic
                // close, or a manual Force Sell/Sell Position from the
                // dashboard) already closed this exact position first,
                // { closed: false } comes back and this must NOT log a
                // second, misleading "position closed" line for an
                // action that didn't actually happen here.
                const outcome = repository.closePosition(position, { exitPrice, roiPct: 0, feeUsd: 0, slippagePct: 0, durationSeconds, reason: `${reason}_NO_REAL_BALANCE` });
                if(!outcome.closed){
                    return { closed: false, reason: "ALREADY_CLOSED" };
                }
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
            txHash = result.txHash ?? null;

        }

        // Production Stabilization V1 Final Sprint (Section I): same
        // idempotency check as the no-real-balance branch above - a real
        // SELL may have already executed (this exact call reached here
        // via a genuinely successful real transaction), but if a
        // concurrent caller's closePosition() already won the race for
        // this position.id, this call must not also log a second SELL
        // line or claim credit for a close that the database says
        // already happened. The real on-chain SELL itself already ran by
        // this point either way - this only governs the application-side
        // bookkeeping, never a second real trade.
        const outcome = repository.closePosition(position, {

            exitPrice, roiPct, feeUsd,
            slippagePct: config.slippage_pct || 0,
            durationSeconds, reason,
            txHash, closeExecutionId

        });

        if(!outcome.closed){
            return { closed: false, reason: "ALREADY_CLOSED" };
        }

        const kind = closeExecutionId ? "Real" : (options.skipBalanceCheck ? "Detected External" : "Virtual");
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

        // Live Decision Center / Signal Center sprint: record WHEN a new
        // peak/trough excursion is reached (Position Detail's timeline
        // "Highest"/"Lowest" stage). Only stamp a fresh timestamp on an
        // actual new extreme this call - otherwise forward the position's
        // existing mfe_at/mae_at unchanged, since updatePositionTracking
        // writes exactly what it's given every cycle (never re-derives).
        const mfeAt = mfePctNow > (position.mfe_pct || 0) ? new Date().toISOString() : (position.mfe_at ?? null);
        const maeAt = maePctNow < (position.mae_pct || 0) ? new Date().toISOString() : (position.mae_at ?? null);

        // Momentum Validation System sprint: same "stamp only on a
        // genuine first crossing, otherwise forward unchanged" pattern -
        // records the lifecycle timeline's +5%/+10% stages. "Reversal" is
        // deliberately not a separate timestamp here - mfe_at (above) IS
        // the reversal-start moment for whatever decline follows it.
        const crossed5pctAt = mfePctNow >= 5 && (position.mfe_pct || 0) < 5 ? new Date().toISOString() : (position.crossed_5pct_at ?? null);
        const crossed10pctAt = mfePctNow >= 10 && (position.mfe_pct || 0) < 10 ? new Date().toISOString() : (position.crossed_10pct_at ?? null);

        repository.updatePositionTracking(position.id, {
            currentPrice: currentPriceNow, mfePct: mfePctNow, maePct: maePctNow, lastVolume1h: volume1hNow,
            mfeAt, maeAt, crossed5pctAt, crossed10pctAt
        });

        // External-sell detection (Trust/UX sprint): if the user sold
        // this token directly on GMGN (or any other wallet interface)
        // outside CRAB entirely, nothing before this ever noticed - the
        // position sat OPEN forever. Reuses the exact same real balance
        // check finalizeClose() already makes at decided-close time,
        // just moved earlier and made unconditional. Exit price is
        // explicitly an ESTIMATE (last known market price at the moment
        // CRAB noticed) since the real fill already happened elsewhere
        // and CRAB never saw it. LIVE-only, by construction - SIMULATION
        // never sets liveOptions, so this is a zero-cost, zero-risk
        // no-op for every non-LIVE user.
        if(liveOptions){
            const heldBalance = await liveOptions.balanceService.getSplTokenBalance(liveOptions.walletPublicKey, token.token_address);
            if(!Number(heldBalance.amountRaw) || Number(heldBalance.amountRaw) <= 0){
                return finalizeClose(position, currentPriceNow, "SELL_EXTERNAL", config, { skipBalanceCheck: true });
            }
        }

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
