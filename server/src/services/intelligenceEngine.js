// services/intelligenceEngine.js - the Intelligence Engine.
//
// CRAB is a market PARTICIPANT intelligence platform, not a chart-
// analysis tool (see server/INTELLIGENCE_ENGINE.md for the full
// philosophy writeup). This orchestrator computes two independent
// systems and combines them per config/scoringConfig.js:
//
//   PARTICIPANT SCORE (0-100) - who is accumulating, distributing,
//   entering, exiting; who is involved (smart money, KOL, whales,
//   the developer) and how trustworthy they look. This is the
//   PRIMARY driver of the BUY/HOLD/AVOID action.
//
//   MARKET HEALTH (0-100) - liquidity, security, holder
//   distribution, volume, price stability. This CONFIRMS or
//   WEAKENS the participant signal (via confidence and risk) and
//   can VETO to AVOID on a hard safety failure - but it can never
//   on its own turn a weak participant signal into a BUY.
//
// Every module returns hasData:false with a neutral (never zero,
// never full-marks) score when its real underlying data doesn't
// exist - never fabricated, never estimated, never simulated.
//
// This module only ever reads data already sitting in SQLite - it
// never triggers a new live GMGN call itself, so analyzing a token
// is always fast.

const config = require("../config/scoringConfig");

const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const gmgnActivityFeedRepository = require("../repositories/gmgnActivityFeedRepository");
const gmgnHotSearchesRepository = require("../repositories/gmgnHotSearchesRepository");
const gmgnLaunchpadStatsRepository = require("../repositories/gmgnLaunchpadStatsRepository");
const gmgnOndemandCacheRepository = require("../repositories/gmgnOndemandCacheRepository");
const walletRepository = require("../repositories/walletRepository");
const tokenStatusService = require("./tokenStatusService");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");

const accumulation = require("./intelligence/participant/accumulation");
const smartMoney = require("./intelligence/participant/smartMoney");
const kol = require("./intelligence/participant/kol");
const whale = require("./intelligence/participant/whale");
const developer = require("./intelligence/participant/developer");
const sniper = require("./intelligence/participant/sniper");
const bundle = require("./intelligence/participant/bundle");
const insider = require("./intelligence/participant/insider");
const walletQuality = require("./intelligence/participant/walletQuality");
const walletProfitability = require("./intelligence/participant/walletProfitability");

const liquidity = require("./intelligence/market/liquidity");
const security = require("./intelligence/market/security");
const holderDistribution = require("./intelligence/market/holderDistribution");
const volume = require("./intelligence/market/volume");
const priceStability = require("./intelligence/market/priceStability");

const PARTICIPANT_MAX = config.participant.maxTotal;

const MARKET_MAX = config.market.maxTotal;

// =====================================
// DATA GATHERING (the only place this module touches SQL, via
// repositories - never raw queries here)
// =====================================

function buildSecurityFacts(trenchesEntry, cachedSecurity){

    if(trenchesEntry){

        return {

            isHoneypot: trenchesEntry.is_honeypot,

            renouncedMint: trenchesEntry.renounced_mint,

            renouncedFreezeAccount: trenchesEntry.renounced_freeze_account,

            rugRatio: trenchesEntry.rug_ratio,

            source: "trenches"

        };

    }

    if(cachedSecurity?.data){

        const d = cachedSecurity.data;

        return {

            isHoneypot: d.is_honeypot === true ? 1 : (d.is_honeypot === false ? 0 : (d.honeypot ? 1 : null)),

            renouncedMint: d.renounced_mint === true ? 1 : (d.renounced_mint === false ? 0 : null),

            renouncedFreezeAccount: d.renounced_freeze_account === true ? 1 : (d.renounced_freeze_account === false ? 0 : null),

            rugRatio: null,

            source: "on-demand cache"

        };

    }

    return null;

}

// CRAB's own wallets table (built from real, already-collected trade
// history - see walletLedgerService.js/walletIntelligenceService.js)
// now covers thousands of wallets, versus the sparse on-demand GMGN
// cache (only ever populated by an explicit per-wallet API call,
// historically ~10 rows total - see the data-integrity audit).
// Normalized into the EXACT shape a real GMGN wallet_stats response
// already has ({common:{tags}, pnl_stat:{token_num, winrate}}) so
// walletQuality.js/walletProfitability.js - already correct, already
// tested - need no changes at all; only the data feeding them gets
// real, broad coverage instead of near-empty.

function toGmgnStatsShape(walletRow){

    const tags = [];

    if((walletRow.total_trades ?? 0) < 3) tags.push("fresh_wallet");

    return {

        common: { tags },

        pnl_stat: { token_num: walletRow.total_trades, winrate: walletRow.win_rate }

    };

}

function gatherCachedWalletStats(addresses, ctx){

    const results = [];

    const seen = new Set();

    for(const addr of addresses){

        if(!addr || seen.has(addr)) continue;

        seen.add(addr);

        const ownWallet = ctx?.walletsByAddress
            ? (ctx.walletsByAddress.get(addr) ?? null)
            : walletRepository.findByAddress(addr);

        if(ownWallet && ownWallet.total_trades > 0 && ownWallet.win_rate != null){

            results.push(toGmgnStatsShape(ownWallet));

            continue;

        }

        const key = gmgnOndemandCacheRepository.buildCacheKey("wallet_stats", { chain: "sol", walletAddress: addr });

        const cached = ctx?.cacheMap ? (ctx.cacheMap.get(key) ?? null) : gmgnOndemandCacheRepository.getIgnoringExpiry(key);

        if(cached?.data) results.push(cached.data);

    }

    return results;

}

// =====================================
// BATCH PRELOAD (list-mode performance path)
//
// Everything analyzeToken() would otherwise fetch one-token-at-a-time
// (trenches, activity feed, hot searches, on-demand cache, launchpad
// stats), gathered up front in a small, fixed number of queries for
// a whole page of tokens. Scoring logic is untouched - this only
// changes WHERE the data comes from (a preloaded Map instead of a
// per-token SQL call), so a token's computed signal is identical
// whether analyzeToken() is called alone or via analyzeTokens().
// =====================================

function preloadContext(tokens){

    const addresses = tokens.map(t => t.token_address);

    const trenchesByAddress = gmgnTrenchesRepository.findManyByTokenAddresses(addresses);

    const hotSearchByAddress = gmgnHotSearchesRepository.findManyByTokenAddresses(addresses);

    // Full table per feed type, grouped in memory - see
    // findAllByType's own doc comment for why this can't be capped
    // the way findByType() is for the public activity endpoints.
    const smartMoneyByAddress = groupByToken(gmgnActivityFeedRepository.findAllByType("smart_money"));

    const kolByAddress = groupByToken(gmgnActivityFeedRepository.findAllByType("kol"));

    const creatorAddresses = [...trenchesByAddress.values()].map(t => t.creator).filter(Boolean);

    const walletAddresses = new Set(creatorAddresses);

    for(const list of smartMoneyByAddress.values()) list.forEach(a => a.maker_address && walletAddresses.add(a.maker_address));

    for(const list of kolByAddress.values()) list.forEach(a => a.maker_address && walletAddresses.add(a.maker_address));

    const cacheKeys = [];

    for(const address of addresses){

        cacheKeys.push(gmgnOndemandCacheRepository.buildCacheKey("token_security", { chain: "sol", address }));

        cacheKeys.push(gmgnOndemandCacheRepository.buildCacheKey("token_top_holders", { chain: "sol", address }));

    }

    for(const walletAddress of walletAddresses){

        cacheKeys.push(gmgnOndemandCacheRepository.buildCacheKey("wallet_activity", { chain: "sol", walletAddress }));

        cacheKeys.push(gmgnOndemandCacheRepository.buildCacheKey("wallet_stats", { chain: "sol", walletAddress }));

    }

    const cacheMap = gmgnOndemandCacheRepository.getManyIgnoringExpiry(cacheKeys);

    const walletsByAddress = walletRepository.findManyByAddresses([...walletAddresses]);

    const launchpadNames = [...new Set([...trenchesByAddress.values()].map(t => t.launchpad).filter(Boolean))];

    const launchpadStatsByName = new Map(launchpadNames.map(name => [name, gmgnLaunchpadStatsRepository.findByLaunchpad(name)]));

    return { trenchesByAddress, hotSearchByAddress, smartMoneyByAddress, kolByAddress, cacheMap, walletsByAddress, launchpadStatsByName };

}

function groupByToken(rows){

    const map = new Map();

    for(const row of rows){

        if(!map.has(row.token_address)) map.set(row.token_address, []);

        map.get(row.token_address).push(row);

    }

    return map;

}

// =====================================
// ACTION / CONFIDENCE / RISK
// =====================================

function scoreToAction(participantScore){

    if(participantScore >= config.actionTiers.strongBuy) return "STRONG BUY";

    if(participantScore >= config.actionTiers.buy) return "BUY";

    if(participantScore >= config.actionTiers.hold) return "HOLD";

    return "AVOID";

}

// =====================================
// STRUCTURAL SELF-VALIDATION / OUTCOME-BASED PENALTY (see
// config/scoringConfig.js for the full reasoning) - counts real,
// already-available evidence that directly contradicts a bullish
// participant read (real downtrend, a dump in progress, a real
// drawdown from an observed peak, real net distribution, smart
// money/KOL actually exiting), then applies a real point PENALTY
// directly to participantScore itself - not a cosmetic action-label
// downgrade layered on top of an unchanged number. This is the
// literal fix for "the participant score itself must come down when
// real evidence disagrees with it": the score IS the flagged-down
// number, so the timeline, the trade plan, and the action tier all
// inherit the correction automatically instead of needing separate
// patches in three places. Runs AFTER the raw per-module participant
// score is combined and BEFORE scoreToAction()/the hard safety veto -
// this is a graduated, evidence-COUNTED correction, not the absolute
// safety net that veto is.
// =====================================

function computeStructuralRedFlags(token, trenchesEntry, participantModules){

    const s = config.structuralValidation;

    const flags = [];

    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;

    const change5m = token.price_change_5m != null ? Number(token.price_change_5m) : null;

    if(change1h != null && change1h <= s.downtrend1hPct){

        flags.push(`Real downtrend: price down ${Math.abs(change1h).toFixed(1)}% in the last hour`);

    }

    if(change5m != null && change5m <= s.recentDump5mPct){

        flags.push(`Recent dump detected: price down ${Math.abs(change5m).toFixed(1)}% in the last 5 minutes`);

    }

    const peak = tokenPriceHistoryRepository.findPeakPrice(token.token_address);

    if(peak != null && peak > 0 && token.price != null){

        const drawdown = (peak - Number(token.price)) / peak;

        if(drawdown >= s.structuralBreakdownDrawdown){

            flags.push(`Structural breakdown: price is ${(drawdown*100).toFixed(0)}% below its real observed peak on this platform`);

        }

    }

    if(trenchesEntry?.net_buy_24h != null && Number(trenchesEntry.net_buy_24h) <= s.netDistributionUsd){

        flags.push(`Net distribution confirmed: $${Math.abs(Math.round(trenchesEntry.net_buy_24h)).toLocaleString()} net sold (24h)`);

    }

    if(participantModules.smartMoney.hasData && participantModules.smartMoney.score <= participantModules.smartMoney.max * s.distributingSubScoreFraction){

        flags.push("Smart money is net exiting this token, not accumulating");

    }

    if(participantModules.kol.hasData && participantModules.kol.score <= participantModules.kol.max * s.distributingSubScoreFraction){

        flags.push("KOL wallets are net exiting this token, not accumulating");

    }

    return flags;

}

function applyStructuralPenalty(participantScoreRaw, redFlags){

    const s = config.structuralValidation;

    const penalty = Math.min(s.maxPenalty, redFlags.length * s.penaltyPerFlag);

    const penalized = Math.max(0, Math.round(participantScoreRaw - penalty));

    return {

        participantScore: penalized,

        participantScoreRaw,

        penaltyApplied: penalty,

        redFlags

    };

}

function applySafetyVeto(action, securityFacts, liquidityFacts, holders){

    const v = config.safetyVeto;

    if(securityFacts?.isHoneypot === 1) return { action: "AVOID", vetoed: true, reason: "Security veto: flagged as a possible honeypot" };

    if(Number(liquidityFacts.liquidity || 0) < v.minLiquidityUsd) return { action: "AVOID", vetoed: true, reason: `Security veto: liquidity below $${v.minLiquidityUsd}` };

    if(liquidityFacts.backingRatio != null && liquidityFacts.backingRatio < v.minBackingRatio) return { action: "AVOID", vetoed: true, reason: "Security veto: liquidity critically thin relative to valuation" };

    if(holders != null && holders < v.minHolders) return { action: "AVOID", vetoed: true, reason: `Security veto: fewer than ${v.minHolders} holders` };

    return { action, vetoed: false, reason: null };

}

// Combines a set of sub-modules into one 0..maxTotal score.
//
// Deliberately NOT a flat sum of each module's score (which would
// default every hasData:false module to its neutral floor and
// permanently cap the total whenever several categories are
// unavailable - exactly the trap this engine fell into on first
// live testing: a token with a genuinely strong, fully real smart-
// money signal but no gmgn_trenches presence could never exceed
// ~60/100, because 60% of the participant weight sat at a neutral
// floor for reasons unrelated to that token's actual quality).
//
// Instead: renormalize across whatever categories DO have real
// data, so the score reflects what is actually known. The resulting
// lower data completeness is accounted for separately, in
// confidence - never by silently suppressing the score itself.

function combineScore(modules, maxTotal, neutralFraction){

    const values = Object.values(modules);

    const availableWeight = values.filter(m => m.hasData).reduce((sum,m) => sum+m.max, 0);

    if(availableWeight === 0){

        return Math.round(maxTotal * neutralFraction);

    }

    const availableScore = values.filter(m => m.hasData).reduce((sum,m) => sum+m.score, 0);

    return Math.round((availableScore / availableWeight) * maxTotal);

}

function computeConfidence(participantScore, marketScore, allModules, freshnessPenalty){

    const c = config.confidence;

    const participantPct = participantScore / PARTICIPANT_MAX;

    const marketPct = marketScore / MARKET_MAX;

    const blended = 100 * (c.participantWeight*participantPct + c.marketWeight*marketPct);

    const mismatch = Math.abs(participantPct - marketPct) * 100;

    const mismatchPenalty = mismatch * c.mismatchPenaltyPerPoint;

    const completeness = allModules.filter(m => m.hasData).length / allModules.length;

    const completenessPenalty = (1 - completeness) * c.maxCompletenessPenalty;

    return Math.round(Math.min(c.max, Math.max(c.min, blended - mismatchPenalty - completenessPenalty - freshnessPenalty)));

}

// =====================================
// FRESHNESS / LIFECYCLE
//
// A token's gmgn_tokens row is only as fresh as the last time it
// appeared in GMGN's trending top-N (see the data-integrity audit) -
// nothing deletes or flags a row once a token falls out of that
// response, so without this, a token untouched for hours would be
// scored and displayed exactly like one updated 10 seconds ago.
// =====================================

// SQLite CURRENT_TIMESTAMP is stored as "YYYY-MM-DD HH:MM:SS" (UTC,
// no offset) - append "Z" so Date parses it as UTC instead of local
// time, the same convention already used by gmgnOndemandCacheRepository.

function ageSecondsSince(timestamp){

    if(!timestamp) return null;

    const then = new Date(`${String(timestamp).replace(" ", "T")}Z`).getTime();

    if(Number.isNaN(then)) return null;

    return Math.max(0, (Date.now() - then) / 1000);

}

function lifecycleForAge(ageSeconds){

    if(ageSeconds == null) return "UNKNOWN";

    const l = config.freshness.lifecycle;

    if(ageSeconds <= l.activeMaxAgeSeconds) return "ACTIVE";

    if(ageSeconds <= l.watchlistMaxAgeSeconds) return "WATCHLIST";

    return "ARCHIVED";

}

function freshnessBlock(ageSeconds, collectedAt){

    return { hasData: ageSeconds != null, ageSeconds: ageSeconds != null ? Math.round(ageSeconds) : null, collectedAt: collectedAt ?? null, status: lifecycleForAge(ageSeconds) };

}

function computeFreshnessPenalty(marketAgeSeconds){

    if(marketAgeSeconds == null) return 0;

    const f = config.freshness.confidencePenalty;

    const ratio = Math.min(1, marketAgeSeconds / f.fullPenaltyAfterSeconds);

    return ratio * f.maxPenalty;

}

// Not a new signal - the same price_change_1h-based lateness
// measurement already driving the participant earliness curve and
// the market priceStability curve, exposed as a plain label.

function deriveStage(change1h){

    if(change1h == null) return "UNKNOWN";

    const abs = Math.abs(change1h);

    if(abs <= config.stage.earlyMaxAbsChange1h) return "EARLY";

    if(abs <= config.stage.midMaxAbsChange1h) return "MID";

    return "LATE";

}

function computeRisk(riskReasons, hardTriggers){

    const r = config.risk;

    if(hardTriggers.some(Boolean) || riskReasons.length >= r.highAtRiskReasonCount) return "HIGH";

    if(riskReasons.length >= r.mediumAtRiskReasonCount) return "MEDIUM";

    return "LOW";

}

// =====================================
// PUBLIC ENTRY POINT
// =====================================

function analyzeToken(token, ctx){

    const address = token.token_address;

    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;

    // ---- gather real data (once) ----
    //
    // If `ctx` (from preloadContext(), via analyzeTokens()) is
    // supplied, every lookup below is an in-memory Map read instead
    // of a SQL query - same data, same shape, just fetched for the
    // whole page up front instead of once per token. Without `ctx`
    // (the single-token path used by GET /token/:address) this is
    // byte-for-byte the original per-token query behavior.

    const trenchesEntry = ctx
        ? (ctx.trenchesByAddress.get(address) ?? null)
        : gmgnTrenchesRepository.findByTokenAddress(address);

    const smartMoneyActivity = ctx
        ? (ctx.smartMoneyByAddress.get(address) ?? []).slice(0, 20)
        : gmgnActivityFeedRepository.findByToken(address, "smart_money", 20);

    const kolActivity = ctx
        ? (ctx.kolByAddress.get(address) ?? []).slice(0, 20)
        : gmgnActivityFeedRepository.findByToken(address, "kol", 20);

    const hotSearchEntry = ctx
        ? (ctx.hotSearchByAddress.get(address) ?? null)
        : gmgnHotSearchesRepository.findByToken(address);

    const securityCacheKey = gmgnOndemandCacheRepository.buildCacheKey("token_security", { chain: "sol", address });

    const cachedSecurity = ctx
        ? (ctx.cacheMap.get(securityCacheKey) ?? null)
        : gmgnOndemandCacheRepository.getIgnoringExpiry(securityCacheKey);

    const holdersCacheKey = gmgnOndemandCacheRepository.buildCacheKey("token_top_holders", { chain: "sol", address });

    const cachedHolders = ctx
        ? (ctx.cacheMap.get(holdersCacheKey) ?? null)
        : gmgnOndemandCacheRepository.getIgnoringExpiry(holdersCacheKey);

    const creatorAddress = trenchesEntry?.creator || null;

    const cachedCreatorActivity = creatorAddress
        ? (ctx
            ? (ctx.cacheMap.get(gmgnOndemandCacheRepository.buildCacheKey("wallet_activity", { chain: "sol", walletAddress: creatorAddress })) ?? null)
            : gmgnOndemandCacheRepository.getIgnoringExpiry(gmgnOndemandCacheRepository.buildCacheKey("wallet_activity", { chain: "sol", walletAddress: creatorAddress })))
        : null;

    const launchpadStats = trenchesEntry?.launchpad
        ? (ctx
            ? (ctx.launchpadStatsByName.get(trenchesEntry.launchpad) ?? null)
            : gmgnLaunchpadStatsRepository.findByLaunchpad(trenchesEntry.launchpad))
        : null;

    const relevantWallets = [

        creatorAddress,

        ...smartMoneyActivity.map(a => a.maker_address),

        ...kolActivity.map(a => a.maker_address)

    ].filter(Boolean).slice(0, 8);

    const walletStatsList = gatherCachedWalletStats(relevantWallets, ctx);

    const securityFacts = buildSecurityFacts(trenchesEntry, cachedSecurity);

    // ---- FRESHNESS (per category - see config/scoringConfig.js) ----

    const marketAgeSeconds = ageSecondsSince(token.updated_at);

    const securityCollectedAt = trenchesEntry ? trenchesEntry.updated_at : (cachedSecurity?.fetchedAt ?? null);

    const smartMoneyCollectedAt = smartMoneyActivity.length
        ? smartMoneyActivity.map(a => a.tx_timestamp).sort().slice(-1)[0]
        : null;

    const freshness = {

        market: freshnessBlock(marketAgeSeconds, token.updated_at),

        security: freshnessBlock(ageSecondsSince(securityCollectedAt), securityCollectedAt),

        holders: freshnessBlock(ageSecondsSince(cachedHolders?.fetchedAt), cachedHolders?.fetchedAt ?? null),

        smartMoney: freshnessBlock(ageSecondsSince(smartMoneyCollectedAt), smartMoneyCollectedAt)

    };

    const lifecycle = lifecycleForAge(marketAgeSeconds);

    const tokenStatus = tokenStatusService.computeTokenStatus({ token, trenchesEntry, lifecycle, marketAgeSeconds });

    // ---- PARTICIPANT SCORE ----

    const participantModules = {

        accumulation: accumulation.score(trenchesEntry, change1h),

        smartMoney: smartMoney.score(smartMoneyActivity, change1h),

        kol: kol.score(kolActivity, change1h),

        whale: whale.score(trenchesEntry),

        developer: developer.score(trenchesEntry),

        sniperQuality: sniper.score(trenchesEntry),

        bundleQuality: bundle.score(trenchesEntry),

        insiderQuality: insider.score(trenchesEntry),

        walletQuality: walletQuality.score(walletStatsList),

        walletProfitability: walletProfitability.score(walletStatsList)

    };

    const participantScoreRaw = combineScore(participantModules, PARTICIPANT_MAX, config.participant.neutralFraction);

    // Real evidence check BEFORE the safety-net veto: does actual
    // price trend/flow data agree with what the per-module scores
    // above just computed? Detected from trenchesEntry/token fields
    // already gathered above, plus the smartMoney/kol module scores
    // already computed this same call - nothing new is fetched.
    const structuralRedFlags = computeStructuralRedFlags(token, trenchesEntry, participantModules);

    const structuralPenalty = applyStructuralPenalty(participantScoreRaw, structuralRedFlags);

    const participantScore = structuralPenalty.participantScore;

    const reasons = Object.values(participantModules).flatMap(m => m.reasons);

    const participantRiskReasons = Object.values(participantModules).flatMap(m => m.riskReasons);

    // ---- MARKET HEALTH ----

    const marketModules = {

        liquidity: liquidity.score(token),

        security: security.score(securityFacts),

        holderDistribution: holderDistribution.score(token, trenchesEntry),

        volume: volume.score(token),

        priceStability: priceStability.score(token)

    };

    const marketScore = combineScore(marketModules, MARKET_MAX, config.market.neutralFraction);

    const confirmations = Object.values(marketModules).flatMap(m => m.confirmations);

    const marketRiskReasons = Object.values(marketModules).flatMap(m => m.riskReasons);

    const riskReasons = [...participantRiskReasons, ...marketRiskReasons];

    // ---- ACTION (participant-driven off the ALREADY-PENALIZED score;
    // market safety facts can only ever move it down further, never up) ----

    const baseAction = scoreToAction(participantScore);

    if(structuralPenalty.penaltyApplied > 0){

        riskReasons.unshift(`Self-validation: participant score reduced ${structuralPenalty.participantScoreRaw} -> ${participantScore} (-${structuralPenalty.penaltyApplied}): ${structuralRedFlags.join("; ")}`);

    }

    const veto = applySafetyVeto(baseAction, securityFacts, marketModules.liquidity.facts, token.holders != null ? Number(token.holders) : null);

    const action = veto.action;

    if(veto.vetoed) riskReasons.unshift(veto.reason);

    // ---- CONFIDENCE / RISK ----

    const allModules = [...Object.values(participantModules), ...Object.values(marketModules)];

    const freshnessPenalty = computeFreshnessPenalty(marketAgeSeconds);

    const confidence = computeConfidence(participantScore, marketScore, allModules, freshnessPenalty);

    const hardTriggers = [

        veto.vetoed,

        change1h != null && change1h >= 500

    ];

    const risk = computeRisk(riskReasons, hardTriggers);

    if(!reasons.length) reasons.push("No strong participant signal detected yet");

    return {

        action,

        stage: deriveStage(change1h),

        participantScore,

        participantMax: PARTICIPANT_MAX,

        marketHealth: marketScore,

        marketHealthMax: MARKET_MAX,

        confidence,

        risk,

        lifecycle,

        tokenStatus,

        freshness,

        selfValidation: {

            checked: true,

            penalized: structuralPenalty.penaltyApplied > 0,

            redFlags: structuralPenalty.redFlags,

            participantScoreBeforePenalty: structuralPenalty.participantScoreRaw,

            participantScoreAfterPenalty: participantScore,

            penaltyApplied: structuralPenalty.penaltyApplied

        },

        reasons,

        confirmations,

        riskReasons,

        computedAt: new Date().toISOString(),

        breakdown: {

            participant: Object.fromEntries(Object.entries(participantModules).map(([k,m]) => [k, { score:m.score, max:m.max, hasData:m.hasData }])),

            market: Object.fromEntries(Object.entries(marketModules).map(([k,m]) => [k, { score:m.score, max:m.max, hasData:m.hasData }]))

        },

        intelligence: {

            security: securityFacts ? { hasData: true, ...securityFacts } : { hasData: false },

            holders: {

                hasData: token.holders != null,

                count: token.holders,

                top10HolderRate: trenchesEntry?.top_10_holder_rate ?? null,

                topHoldersListCached: Boolean(cachedHolders),

                topHoldersFetchedAt: cachedHolders?.fetchedAt ?? null

            },

            smartMoney: { hasData: smartMoneyActivity.length > 0, activities: smartMoneyActivity },

            kol: { hasData: kolActivity.length > 0, activities: kolActivity },

            trenches: trenchesEntry ? {

                hasData: true,

                section: trenchesEntry.section,

                status: trenchesEntry.status,

                progress: trenchesEntry.progress,

                swaps24h: trenchesEntry.swaps_24h,

                buys24h: trenchesEntry.buys_24h,

                sells24h: trenchesEntry.sells_24h,

                netBuy24h: trenchesEntry.net_buy_24h,

                sniperCount: trenchesEntry.sniper_count,

                smartDegenCount: trenchesEntry.smart_degen_count

            } : { hasData: false },

            devWallet: trenchesEntry?.creator ? { hasData: true, address: trenchesEntry.creator } : { hasData: false },

            walletActivity: cachedCreatorActivity ? {

                hasData: true,

                walletAddress: creatorAddress,

                fetchedAt: cachedCreatorActivity.fetchedAt,

                activities: cachedCreatorActivity.data?.activities ?? []

            } : { hasData: false },

            walletStatsChecked: walletStatsList.length,

            hotSearches: hotSearchEntry ? { hasData: true, interval: hotSearchEntry.interval, rank: hotSearchEntry.rank_position } : { hasData: false },

            launchpad: trenchesEntry?.launchpad ? {

                hasData: true,

                platform: trenchesEntry.launchpad_platform || trenchesEntry.launchpad,

                totalTokensOnPlatform: launchpadStats?.token_count ?? null

            } : { hasData: false }

        }

    };

}

// List-mode entry point - same per-token result as calling
// analyzeToken() individually for every row, but at a fixed, small
// number of queries for the whole page instead of ~8-16 queries PER
// token. Used by tokenQueryService for /tokens, /trending, /search;
// GET /token/:address still calls analyzeToken() directly (a single
// token doesn't need the batch machinery).

function analyzeTokens(tokens){

    if(!tokens.length) return [];

    const ctx = preloadContext(tokens);

    return tokens.map(token => analyzeToken(token, ctx));

}

module.exports = { analyzeToken, analyzeTokens, PARTICIPANT_MAX, MARKET_MAX };
