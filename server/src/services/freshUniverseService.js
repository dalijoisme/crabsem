// services/freshUniverseService.js - Fresh BUY Universe RFC (approved
// architecture: misty-floating-quasar.md). Production proved the root
// cause with real data: 14,023 tokens scanned, 237 qualified BUY/STRONG
// BUY, opened = 0 - 286 rejected by entryGateService.js's Entry Gate
// with STALE_MARKET_DATA. The Entry Gate was correct; the universe fed
// into scoring/ranking (scheduler/tradingBotScheduler.js's tick(), via
// gmgnTokenRepository.getAllTokens()) still included rows the collector
// stopped refreshing once a token fell out of GMGN's trending list.
// This service pre-filters BEFORE scoring, so stale rows never reach
// the Research Engine at all.
//
// Scope, deliberately narrow (CTO's approval enhancement): this service
// answers ONLY "is this token still a valid live candidate?" - freshness
// and minimum market cap, both global/profile-independent floors, exactly
// like entryGateService.js's own MAX_MARKET_DATA_AGE_SECONDS. It does
// NOT accept minVolume/minLiquidity - those already exist as per-user,
// per-Strategy-Profile safety-veto thresholds
// (services/strategyProfileTranslator.js's minLiquidityUsd/minVolumeUsd,
// applied deep in services/intelligenceEngine.js/researchEngineFactory.js/
// candidateEngineV2.js). Duplicating them here would either violate this
// codebase's "no duplicate filtering" rule (Constitution clause 10, cited
// in entryGateService.js) or be structurally wrong, since this universe
// is built ONCE per tick, shared across every due user, before any
// user's own profile is known. "Should this specific user/profile buy
// it?" stays the Research Engine's question, never this file's.

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const { MAX_MARKET_DATA_AGE_SECONDS } = require("./entryGateService");

// today's existing floor (scheduler/tradingBotScheduler.js's inline
// `t.market_cap != null && t.market_cap > 0`) - now a named, overridable
// constant instead of a second inline literal.
const DEFAULT_MIN_MARKET_CAP = 0;

function getBuyCandidateUniverse(overrides = {}){

    const maxAgeSeconds = overrides.maxAgeSeconds ?? MAX_MARKET_DATA_AGE_SECONDS;
    const minMarketCap = overrides.minMarketCap ?? DEFAULT_MIN_MARKET_CAP;

    // collector_total_count (pipeline observability enhancement): the
    // real, unfiltered size of gmgn_tokens at this instant - reuses the
    // existing countTokens(), never a second query duplicating it.
    const collectorTotalCount = gmgnTokenRepository.countTokens();
    const tokens = gmgnTokenRepository.getFreshTokens({ maxAgeSeconds, minMarketCap });

    return { tokens, collectorTotalCount, freshUniverseCount: tokens.length, maxAgeSeconds, minMarketCap };

}

module.exports = { getBuyCandidateUniverse, DEFAULT_MIN_MARKET_CAP };
