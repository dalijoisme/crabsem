// services/entryGateService.js - Benchmark Harness Architecture section 3:
// extracted from tradingBotEngine.js's private evaluateEntry(), verbatim,
// with its two repository calls (findOpenPositionForToken/findLastTradeForToken)
// now taking a `repository` parameter instead of hardcoding
// tradingBotRepository - so the live bot and the Benchmark Harness call
// the EXACT same 8 gate checks, never two copies of them.
//
// This is a pure extraction, not new logic - every check, every order,
// every reason string is unchanged from tradingBotEngine.js's original
// evaluateEntry(). createEntryGateService(tradingBotRepository) below is
// what tradingBotEngine.js now uses, so its behavior is byte-identical
// to before this file existed.

const qualityGateService = require("./qualityGateService");
const productionEngineResolver = require("./productionEngineResolver");

function minutesSince(sqliteTimestamp){
    if(!sqliteTimestamp) return Infinity;
    const then = new Date(`${String(sqliteTimestamp).replace(" ", "T")}Z`).getTime();
    return Math.max(0, (Date.now() - then) / 60000);
}

function requiredCooldownMinutes(lastTrade, config){
    if(!lastTrade) return 0;
    const reason = lastTrade.reason || "";
    if(reason === "TAKE_PROFIT") return config.cooldown_win_minutes;
    if(reason === "STOP_LOSS") return config.cooldown_loss_minutes;
    if(reason === "SIGNAL_REVERSED" || reason === "REVERSAL") return config.cooldown_reversal_minutes;
    return config.cooldown_default_minutes;
}

// Real, already-computed structural red flags (intelligenceEngine.js's
// self-validation penalty) - re-used here as extra scrutiny for
// RE-ENTRIES specifically. Not a new metric; the same field the engine
// already reports via signal.selfValidation.redFlags. Repository-
// independent - never touches position/trade state.
function passesReentryScrutiny(token){
    const active = productionEngineResolver.getActiveEngine();
    const signal = active.analyzeToken(token);
    return (signal.selfValidation?.redFlags?.length || 0) === 0;
}

// repository: any object implementing findOpenPositionForToken(tokenAddress)
// and findLastTradeForToken(tokenAddress) - tradingBotRepository already
// does; a benchmark participant's scoped repository (see
// benchmarkPositionRepository.forParticipant) implements the same shape.
function createEntryGateService(repository){

    // `live` is a REQUIRED parameter, precomputed once per token per cycle
    // by the caller - never recomputed here (Constitution clause 10 - no
    // duplicate filtering).
    function evaluateEntry(token, live, config, openCount){

        if(!live.hasDecision) return { eligible: false, reason: "NO_ENGINE_DECISION_YET" };

        if(live.excludeFromTrending) return { eligible: false, reason: `HARD_EXCLUDED_${live.exclusionReason}` };

        if(live.action !== "BUY" && live.action !== "STRONG BUY") return { eligible: false, reason: `NOT_A_BUY_TIER_${live.action}` };

        if(live.decayFraction < config.min_decay_fraction){
            return { eligible: false, reason: "DECISION_TOO_STALE" };
        }

        if(live.confidence < config.min_confidence){
            return { eligible: false, reason: "CONFIDENCE_BELOW_FLOOR" };
        }

        const quality = qualityGateService.passesQualityGate(token, config.qualityGateOverrides);
        if(!quality.pass) return { eligible: false, reason: `QUALITY_GATE_${quality.reason}` };

        if(openCount >= config.max_open_positions){
            return { eligible: false, reason: "MAX_OPEN_POSITIONS_REACHED" };
        }

        if(config.one_position_per_token && repository.findOpenPositionForToken(token.token_address)){
            return { eligible: false, reason: "ALREADY_OPEN_FOR_TOKEN" };
        }

        const lastTrade = repository.findLastTradeForToken(token.token_address);
        const cooldownNeeded = requiredCooldownMinutes(lastTrade, config);

        if(lastTrade && minutesSince(lastTrade.closed_at) < cooldownNeeded){
            return { eligible: false, reason: `COOLDOWN_ACTIVE_${lastTrade.reason || "UNKNOWN"}` };
        }

        // Re-entry (a previous trade exists for this token, cooldown has
        // elapsed) gets a stricter bar than a token's first-ever entry.
        if(lastTrade && !passesReentryScrutiny(token)){
            return { eligible: false, reason: "REENTRY_STRUCTURAL_RED_FLAG" };
        }

        return { eligible: true, live, isReentry: Boolean(lastTrade) };

    }

    return { evaluateEntry };

}

// Sprint A, Goal 2 (auth/multi-tenancy foundation): the old default
// instance bound directly to the raw tradingBotRepository module is
// removed - that module's functions now all take a leading userId
// (repository/tradingBotRepository.js), so a single global binding no
// longer means anything. services/tradingBotEngine.js now calls
// createEntryGateService(tradingBotRepository.forUser(userId)) per
// user, per cycle - the exact same factory every other caller
// (benchmarkRunner.js, benchmarkRunService.js, entryGateService.test.js)
// already used.

module.exports = { createEntryGateService };
