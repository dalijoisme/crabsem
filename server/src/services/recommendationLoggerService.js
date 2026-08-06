// services/recommendationLoggerService.js - records what the
// Intelligence Engine actually recommended, once per scheduler tick,
// for every currently-tracked token. This is the only way the
// validation framework (Sprint 2) can later be checked against real
// outcomes - the engine itself never persists a recommendation (see
// intelligenceEngine.js's own doc comment), so without this there
// would be nothing to evaluate.

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const recommendationLogRepository = require("../repositories/recommendationLogRepository");
const intelligenceEngine = require("./intelligenceEngine");

// TEMPORARY (validation-scheduler stall investigation, 2026-08-06) -
// wall-clock (process.hrtime.bigint, immune to system clock
// adjustments) + CPU time (process.cpuUsage, isolates this call's own
// user+system CPU consumption from the rest of the process) + row
// count around the two real candidates for a main-thread block:
// analyzeTokens() (the same unbounded, non-worker-offloaded,
// full-table intelligence-engine pass predictionValidationService.js's
// evaluateAndRecordDecisions already had and was fixed for, in commits
// d4d99fa/230ab27 - this file was never touched by that fix) and the
// surrounding entries.map()/insertMany() work. Zero behavior change -
// no return value, control flow, or error handling below is touched,
// only console.log calls are added. Remove once the investigation
// concludes.
function logRecommendations(){

    const _diagWallStart = process.hrtime.bigint();
    const _diagCpuStart = process.cpuUsage();

    const tokens = gmgnTokenRepository.getAllTokens();

    if(!tokens.length) return { logged: 0 };

    const _diagAnalyzeWallStart = process.hrtime.bigint();
    const _diagAnalyzeCpuStart = process.cpuUsage();

    const signals = intelligenceEngine.analyzeTokens(tokens);

    const _diagAnalyzeWallMs = Number(process.hrtime.bigint() - _diagAnalyzeWallStart) / 1e6;
    const _diagAnalyzeCpu = process.cpuUsage(_diagAnalyzeCpuStart);
    console.log(`[recommendation-logger-diag] analyzeTokens: tokens=${tokens.length} wallMs=${_diagAnalyzeWallMs.toFixed(1)} cpuUserMs=${(_diagAnalyzeCpu.user / 1000).toFixed(1)} cpuSystemMs=${(_diagAnalyzeCpu.system / 1000).toFixed(1)}`);

    const entries = tokens.map((token, i) => {

        const s = signals[i];

        // Real snapshot of the participant wallet composition that
        // fed THIS recommendation - not a new lookup, just persisting
        // counts already gathered by analyzeToken() this same call
        // (see intelligenceEngine.js's `intelligence` block). This is
        // the "Next Foundation" data a future learning system needs
        // to explain why a recommendation was made, not just what it
        // was (see migration 009).

        const walletSummary = {

            smartMoneyWalletCount: s.intelligence.smartMoney.activities?.length || 0,

            kolWalletCount: s.intelligence.kol.activities?.length || 0,

            devWalletIdentified: s.intelligence.devWallet.hasData,

            walletStatsChecked: s.intelligence.walletStatsChecked || 0

        };

        return {

            tokenAddress: token.token_address,

            symbol: token.symbol,

            action: s.action,

            stage: s.stage,

            participantScore: s.participantScore,

            marketHealth: s.marketHealth,

            confidence: s.confidence,

            risk: s.risk,

            lifecycle: s.lifecycle,

            priceAtRecommendation: token.price,

            marketCapAtRecommendation: token.market_cap != null ? Number(token.market_cap) : null,

            walletSummaryJson: JSON.stringify(walletSummary),

            reasonsJson: JSON.stringify(s.reasons),

            confirmationsJson: JSON.stringify(s.confirmations),

            riskReasonsJson: JSON.stringify(s.riskReasons),

            breakdownJson: JSON.stringify(s.breakdown)

        };

    });

    const _diagInsertWallStart = process.hrtime.bigint();
    const _diagInsertCpuStart = process.cpuUsage();

    recommendationLogRepository.insertMany(entries);

    const _diagInsertWallMs = Number(process.hrtime.bigint() - _diagInsertWallStart) / 1e6;
    const _diagInsertCpu = process.cpuUsage(_diagInsertCpuStart);
    console.log(`[recommendation-logger-diag] insertMany: rows=${entries.length} wallMs=${_diagInsertWallMs.toFixed(1)} cpuUserMs=${(_diagInsertCpu.user / 1000).toFixed(1)} cpuSystemMs=${(_diagInsertCpu.system / 1000).toFixed(1)}`);

    const _diagWallMs = Number(process.hrtime.bigint() - _diagWallStart) / 1e6;
    const _diagCpu = process.cpuUsage(_diagCpuStart);
    console.log(`[recommendation-logger-diag] logRecommendations TOTAL: tokens=${tokens.length} wallMs=${_diagWallMs.toFixed(1)} cpuUserMs=${(_diagCpu.user / 1000).toFixed(1)} cpuSystemMs=${(_diagCpu.system / 1000).toFixed(1)}`);

    return { logged: entries.length };

}

module.exports = { logRecommendations };
