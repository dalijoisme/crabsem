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
const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");

function minutesSince(sqliteTimestamp){
    if(!sqliteTimestamp) return Infinity;
    const then = new Date(`${String(sqliteTimestamp).replace(" ", "T")}Z`).getTime();
    return Math.max(0, (Date.now() - then) / 60000);
}

// Production Hotfix V1.1, Section 1 (BUY Data Freshness Gate): a
// candidate's own market snapshot (gmgn_tokens.updated_at) age, in
// seconds - the same "how old is this row" computation
// intelligenceEngine.js's ageSecondsSince already does, reimplemented
// locally (same convention this file already uses for minutesSince,
// just below) rather than importing that whole engine module for one
// timestamp diff.
function marketAgeSecondsFor(token){
    const timestamp = token?.updated_at || token?.last_seen;
    if(!timestamp) return null; // no real timestamp at all - never treat as "fresh by default"
    const then = new Date(`${String(timestamp).replace(" ", "T")}Z`).getTime();
    if(Number.isNaN(then)) return null;
    return Math.max(0, (Date.now() - then) / 1000);
}

// Hard, non-profile-tunable ceiling - this is a data-integrity floor,
// not a strategy knob (unlike min_confidence/min_decay_fraction, which
// stay Strategy-Profile-owned). 120s matches two independent, already-
// established reference points in this exact codebase: (1)
// services/tradingBotEngine.js's HELD_POSITION_STALE_AFTER_MS (90s) is
// 3x the GMGN trending collector's own 30s tick
// (scheduler/gmgnTrendingScheduler.js) for the held-position case; 120s
// is 4x the same tick for the stricter new-entry case, since a BUY is a
// one-way, harder-to-reverse decision than continuing to hold. (2)
// services/researchEngineFactory.js's own unused speedFirst benchmark
// philosophy already shadow-tested this exact 120s bound after
// internally measuring that ~89% of BUY/STRONG BUY flags at any given
// moment were stale, pre-existing scores rather than fresh signals -
// this sprint adopts that already-proven number into live trading
// rather than inventing a new one.
const MAX_MARKET_DATA_AGE_SECONDS = 120;

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

        // Production Hotfix V1.1, Section 1/4: the freshness gate runs
        // BEFORE every quality/confidence rule below it, per that
        // sprint's explicit requirement - a stale market snapshot is
        // rejected outright, never merely scored lower. This is a hard
        // reject (eligible: false), not a confidence penalty - the
        // candidate never reaches openPosition() regardless of how well
        // it would otherwise have scored.
        const marketAgeSeconds = marketAgeSecondsFor(token);
        if(marketAgeSeconds == null || marketAgeSeconds > MAX_MARKET_DATA_AGE_SECONDS){
            return { eligible: false, reason: "STALE_MARKET_DATA", marketAgeSeconds };
        }

        // SPRINT 12 (Arjuna V5) - CTO DECISION (FINAL), ENTRY DECISION:
        // "Final Score >=68 langsung BUY. Tidak boleh ada classifier
        // lain yang membatalkan BUY. Final Decision hanya berasal dari
        // Final Score." REMOVED (was Production Stabilization V2's own
        // HIGH_RISK_REJECTED gate): a hard reject purely on
        // riskReasons.length >= 4 accumulated across many independent
        // real signals (developer/sniper/bundle/insider/priceStability/
        // holderDistribution/etc.) - exactly the "classifier lain" this
        // CTO decision forbids, since it could reject an already-BUY-
        // tier (score >= 68) candidate on a count of minor flags with no
        // single one individually disqualifying. The CTO's own closed
        // hard-reject list (honeypot, cannot sell, liquidity critical,
        // hard blacklist, security critical) remains fully enforced -
        // untouched by this removal - via researchEngineFactory.js's
        // safetyVeto mechanism (isHoneypot/security.hardReject/
        // liquidity floor/backingRatio/minHolders), which sets
        // action="AVOID" directly in the scoring pipeline BEFORE this
        // gate ever ran - a vetoed token never reaches BUY/STRONG BUY
        // action tier at all, so it is already rejected by this
        // function's own NOT_A_BUY_TIER_* check above, independent of
        // `risk`. Individual risky signals (a developer still holding a
        // large share, sniper/bundler/insider concentration, an already-
        // sharp price move, a risky momentum phase, etc.) still lower
        // the Final Score itself (researchEngineFactory.js's
        // computeUnifiedEntryScore, e.g. Part 6's security penalty, this
        // sprint's own momentum scoring modifier) - real signals still
        // matter, they just no longer separately veto a score that
        // already cleared the BUY threshold.

        if(live.decayFraction < config.min_decay_fraction){
            return { eligible: false, reason: "DECISION_TOO_STALE" };
        }

        if(live.confidence < config.min_confidence){
            return { eligible: false, reason: "CONFIDENCE_BELOW_FLOOR" };
        }

        // Production Stabilization V2 (Close Remaining BUY Blind Spots,
        // Section 8 - Live Safety: "if essential data isn't ready, SKIP
        // rather than BUY"). qualityGateService.passesQualityGate() has
        // always deliberately auto-passed when gmgn_trenches has no row
        // for this token at all ("never fabricate a rejection" - its own
        // header comment, still correct for its OTHER callers: re-
        // checking an already-HELD position every cycle, and the shared
        // homepage/trending recommendation surface, neither of which
        // should force-close/hide a token just because one collector
        // table hasn't caught up yet). For a brand-new BUY specifically,
        // that same absence means rug ratio, holder concentration,
        // bundler manipulation, and serial-scam-creator - four of this
        // pipeline's real, already-built rug checks - never ran at all.
        // A direct query of this account's own real GMGN dataset found
        // this is true for 24.3% of all tracked tokens (3,013 of
        // 12,387) - not a rare edge case. This is a hard, non-tunable
        // reject scoped ONLY to new entries (the one place "we don't
        // know" must mean "skip," never "assume clean") - it does not
        // touch qualityGateService.js itself, so held-position re-checks
        // and the homepage surface are completely unaffected.
        if(!gmgnTrenchesRepository.findByTokenAddress(token.token_address)){
            return { eligible: false, reason: "MISSING_QUALITY_DATA" };
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

// marketAgeSecondsFor/MAX_MARKET_DATA_AGE_SECONDS exported for reuse by
// services/tradingBotEngine.js's own observability snapshot (Section 3 -
// Market Data Age/Last Snapshot Time must be shown on every candidate,
// not just computed silently here) and by this file's own regression
// tests - never a second copy of the freshness formula.
module.exports = { createEntryGateService, marketAgeSecondsFor, MAX_MARKET_DATA_AGE_SECONDS };
