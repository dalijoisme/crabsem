// services/emiService.js - CRAB Trading Bot Constitution v1.0, Final
// Specification section 04 (Early Momentum Intelligence). Pure
// classifier - not an engine (never calls analyzeToken with different
// weights), not a scorer (never produces a number of its own, only a
// boolean + a real-field-traceable reason string), not a filter (never
// rejects a candidate - its only consumer is
// opportunityPriorityService.js's Tier bump, see applyEmiBump there).
// Only ever invoked by tradingBotEngine.js when
// trading_bot_config.emi_enabled = 1 (i.e. Strategy Profile = AGGRESSIVE).
//
// Every input is a real, already-collected field or a formula already
// present elsewhere in this codebase - nothing here recomputes a
// Production V2 metric:
//   - priceAccel reuses, verbatim, the acceleration test already
//     written for the "breakoutHunter" research philosophy in
//     researchEngineFactory.js (5-minute pace annualized to the 1h
//     scale outrunning the trailing hour) - read here as a plain field
//     comparison, never by instantiating that philosophy as an engine.
//   - signalAccel reuses prediction_history.trigger_reason, already
//     written by predictionValidationService.js's trigger-rule engine,
//     and the 15-minute "still fully trusted" boundary already defined
//     by confidenceDecayService.CURVE's first plateau.
//   - tokenAgeMinutes reuses gmgn_tokens.launch_time /
//     gmgn_trenches.created_timestamp, both already collected.

const { COLD_TRIGGER_REASONS } = require("./opportunityPriorityService");

const MAX_AGE_MINUTES = 720; // 12h - EMI only ever considers early-phase tokens
const SIGNAL_FRESHNESS_MINUTES = 15; // confidenceDecayService.CURVE's own first plateau boundary

function minutesSince(sqliteOrEpochTimestamp, isUnixSeconds){
    if(!sqliteOrEpochTimestamp) return null;
    const then = isUnixSeconds
        ? Number(sqliteOrEpochTimestamp) * 1000
        : new Date(`${String(sqliteOrEpochTimestamp).replace(" ", "T")}Z`).getTime();
    if(!Number.isFinite(then)) return null;
    return Math.max(0, (Date.now() - then) / 60000);
}

function resolveTokenAgeMinutes(token, trenchesEntry){
    if(token.launch_time) return minutesSince(token.launch_time, false);
    if(trenchesEntry?.created_timestamp) return minutesSince(trenchesEntry.created_timestamp, true);
    return null;
}

function priceAcceleration(token){
    const change5m = token.price_change_5m != null ? Number(token.price_change_5m) : null;
    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;
    if(change5m == null || change1h == null) return false;
    return change5m > 0 && (change5m * 12) > change1h;
}

function signalAcceleration(historyRows){
    const row0 = historyRows?.[0] ?? null;
    if(!row0?.trigger_reason || COLD_TRIGGER_REASONS.has(row0.trigger_reason)) return false;
    const ageMinutes = minutesSince(row0.prediction_time, false);
    return ageMinutes != null && ageMinutes <= SIGNAL_FRESHNESS_MINUTES;
}

// token: the BUY Candidate row (gmgn_tokens shape). trenchesEntry:
// batchContext.trenchesByToken.get(token.token_address) - the SAME map
// opportunityPriorityService.js already fetched this cycle, never a
// second query. historyRows: batchContext.historyByToken.get(...) -
// same reuse.
function classify(token, trenchesEntry, historyRows){

    const tokenAgeMinutes = resolveTokenAgeMinutes(token, trenchesEntry);

    if(tokenAgeMinutes == null) return { accelerating: false, reason: "NO_AGE_DATA" };
    if(tokenAgeMinutes > MAX_AGE_MINUTES) return { accelerating: false, reason: "TOO_MATURE" };

    const priceAccel = priceAcceleration(token);
    const signalAccel = signalAcceleration(historyRows);

    if(priceAccel && signalAccel) return { accelerating: true, reason: "SIGNAL_AND_PRICE_ACCELERATION" };
    if(priceAccel) return { accelerating: true, reason: "PRICE_ACCELERATION_ONLY" };
    if(signalAccel) return { accelerating: true, reason: "SIGNAL_ACCELERATION_ONLY" };
    return { accelerating: false, reason: "NOT_ACCELERATING" };

}

// tokens: BUY Candidate list. batchContext: opportunityPriorityService.fetchBatchContext(tokens)'s
// result - reused, not re-fetched. Returns Map(token_address -> {accelerating, reason}).
function classifyMany(tokens, batchContext){
    const map = new Map();
    for(const token of tokens){
        map.set(token.token_address, classify(
            token,
            batchContext.trenchesByToken.get(token.token_address),
            batchContext.historyByToken.get(token.token_address)
        ));
    }
    return map;
}

module.exports = { classify, classifyMany, MAX_AGE_MINUTES, SIGNAL_FRESHNESS_MINUTES };
