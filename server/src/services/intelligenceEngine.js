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

function gatherCachedWalletStats(addresses){

    const results = [];

    const seen = new Set();

    for(const addr of addresses){

        if(!addr || seen.has(addr)) continue;

        seen.add(addr);

        const cached = gmgnOndemandCacheRepository.getIgnoringExpiry(

            gmgnOndemandCacheRepository.buildCacheKey("wallet_stats", { chain: "sol", walletAddress: addr })

        );

        if(cached?.data) results.push(cached.data);

    }

    return results;

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

function computeConfidence(participantScore, marketScore, allModules){

    const c = config.confidence;

    const participantPct = participantScore / PARTICIPANT_MAX;

    const marketPct = marketScore / MARKET_MAX;

    const blended = 100 * (c.participantWeight*participantPct + c.marketWeight*marketPct);

    const mismatch = Math.abs(participantPct - marketPct) * 100;

    const mismatchPenalty = mismatch * c.mismatchPenaltyPerPoint;

    const completeness = allModules.filter(m => m.hasData).length / allModules.length;

    const completenessPenalty = (1 - completeness) * c.maxCompletenessPenalty;

    return Math.round(Math.min(c.max, Math.max(c.min, blended - mismatchPenalty - completenessPenalty)));

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

function analyzeToken(token){

    const address = token.token_address;

    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;

    // ---- gather real data (once) ----

    const trenchesEntry = gmgnTrenchesRepository.findByTokenAddress(address);

    const smartMoneyActivity = gmgnActivityFeedRepository.findByToken(address, "smart_money", 20);

    const kolActivity = gmgnActivityFeedRepository.findByToken(address, "kol", 20);

    const hotSearchEntry = gmgnHotSearchesRepository.findByToken(address);

    const cachedSecurity = gmgnOndemandCacheRepository.getIgnoringExpiry(

        gmgnOndemandCacheRepository.buildCacheKey("token_security", { chain: "sol", address })

    );

    const cachedHolders = gmgnOndemandCacheRepository.getIgnoringExpiry(

        gmgnOndemandCacheRepository.buildCacheKey("token_top_holders", { chain: "sol", address })

    );

    const creatorAddress = trenchesEntry?.creator || null;

    const cachedCreatorActivity = creatorAddress

        ? gmgnOndemandCacheRepository.getIgnoringExpiry(

            gmgnOndemandCacheRepository.buildCacheKey("wallet_activity", { chain: "sol", walletAddress: creatorAddress })

          )

        : null;

    const launchpadStats = trenchesEntry?.launchpad

        ? gmgnLaunchpadStatsRepository.findByLaunchpad(trenchesEntry.launchpad)

        : null;

    const relevantWallets = [

        creatorAddress,

        ...smartMoneyActivity.map(a => a.maker_address),

        ...kolActivity.map(a => a.maker_address)

    ].filter(Boolean).slice(0, 8);

    const walletStatsList = gatherCachedWalletStats(relevantWallets);

    const securityFacts = buildSecurityFacts(trenchesEntry, cachedSecurity);

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

    const participantScore = combineScore(participantModules, PARTICIPANT_MAX, config.participant.neutralFraction);

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

    // ---- ACTION (participant-driven, market can only veto down) ----

    const baseAction = scoreToAction(participantScore);

    const veto = applySafetyVeto(baseAction, securityFacts, marketModules.liquidity.facts, token.holders != null ? Number(token.holders) : null);

    const action = veto.action;

    if(veto.vetoed) riskReasons.unshift(veto.reason);

    // ---- CONFIDENCE / RISK ----

    const allModules = [...Object.values(participantModules), ...Object.values(marketModules)];

    const confidence = computeConfidence(participantScore, marketScore, allModules);

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

module.exports = { analyzeToken, PARTICIPANT_MAX, MARKET_MAX };
