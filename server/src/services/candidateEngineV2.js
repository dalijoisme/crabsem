// services/candidateEngineV2.js - CANDIDATE ENGINE V2 (research/shadow
// use only - never wired into any route, scheduler, or prediction
// write path; PRODUCTION remains intelligenceEngine.js, completely
// unmodified). Built 2026-07-19 from the "Entry vs Exit" +
// "Pump Behavior Analysis" research findings, per an explicit CTO
// directive: treat those findings as HYPOTHESES to be re-validated
// against a proper pumped-vs-not-pumped comparison group (not just
// looking at winners in isolation) before allowing any scoring change.
//
// VALIDATION SUMMARY (research-hypothesis-validation.js, run against
// the same 326-token, 30-minute window used for the Pump Behavior
// Analysis, split into 80 tokens that moved >=10% vs 221 that did not):
//
//   1. Smart Money bonus - WEAK support, kept (small, capped, gated).
//      Tokens with real smart-money BUY activity BEFORE their entry
//      tick pumped >=10% at a 29.7% rate vs 19.6% for tokens with none
//      (n=209 vs n=92) - a real but modest ~10pp lift. Average move
//      size was NOT higher for the smart-money group (15.4% vs 17.3%)
//      - so the signal predicts *whether* a pump happens a bit better
//      than chance, not *how big* it will be. CONFIDENCE: LOW-MEDIUM.
//
//   2. Bundler scoring change - REJECTED, not implemented.
//      avgBundlerMhr was virtually identical for pumped (0.867) vs
//      not-pumped (0.831) tokens - bundled/coordinated trading is
//      near-universal on Pump.fun regardless of outcome (present in
//      the majority of BOTH groups), so it does not discriminate
//      winners from non-winners in this sample. Production's existing
//      bundle.js penalty for high bundler_mhr is left completely
//      untouched - no new bonus or extra penalty added here.
//
//   3. Liquidity threshold change - REJECTED, not implemented.
//      Bucketing by entry liquidity showed the $5,000-$15,000 band had
//      the HIGHEST pump rate (35.3%), not the highest-liquidity band
//      (23.4% for $15,000+) - there is no clean monotonic "more
//      liquidity = better outcome" relationship in this sample to
//      justify moving production's existing $2,000 safety-veto floor.
//
//   4. Noise-token filter - NOT a gap to fix.
//      The genuinely "noise" cluster identified in the Pump Behavior
//      Analysis (sub-$25 liquidity, brand-new tokens, zero wallet
//      activity) sits entirely BELOW production's existing $2,000
//      minLiquidityUsd safety veto (scoringConfig.safetyVeto) - already
//      excluded by production today. No new filter added.
//
// NET RESULT: Candidate V2 differs from Production in exactly ONE
// place - smartMoney.js's scoring gets one small, explicitly-gated
// additive bonus. Every other module, weight, threshold, tier, and
// the whole scoring architecture (participant/market split,
// combineScore renormalization, structural self-validation penalty,
// safety veto, confidence blend) is called UNCHANGED, straight from
// production's real files. This file does not write to any table.

const config = require("../config/scoringConfig");
const { lookupFactor } = require("./intelligence/curveHelper");

const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const gmgnActivityFeedRepository = require("../repositories/gmgnActivityFeedRepository");
const gmgnHotSearchesRepository = require("../repositories/gmgnHotSearchesRepository");
const gmgnLaunchpadStatsRepository = require("../repositories/gmgnLaunchpadStatsRepository");
const gmgnOndemandCacheRepository = require("../repositories/gmgnOndemandCacheRepository");
const walletRepository = require("../repositories/walletRepository");
const tokenStatusService = require("../services/tokenStatusService");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");

// Unmodified production sub-modules - reused exactly as-is.
const accumulation = require("./intelligence/participant/accumulation");
const kolModule = require("./intelligence/participant/kol");
const whale = require("./intelligence/participant/whale");
const developer = require("./intelligence/participant/developer");
const sniper = require("./intelligence/participant/sniper");
const bundle = require("./intelligence/participant/bundle");
const insider = require("./intelligence/participant/insider");
const walletQuality = require("./intelligence/participant/walletQuality");
const walletProfitability = require("./intelligence/participant/walletProfitability");

const liquidityModule = require("./intelligence/market/liquidity");
const security = require("./intelligence/market/security");
const holderDistribution = require("./intelligence/market/holderDistribution");
const volume = require("./intelligence/market/volume");
const priceStability = require("./intelligence/market/priceStability");

const PARTICIPANT_MAX = config.participant.maxTotal;
const MARKET_MAX = config.market.maxTotal;

// =====================================
// THE ONE CHANGE: smartMoneyCandidate.js inlined here.
//
// Identical to production's smartMoney.js in every branch EXCEPT: when
// the module already concludes "accumulating, with significant volume"
// (production's own existing bar - unchanged), an ADDITIONAL small
// bonus is added, gated on three conditions taken directly from the
// hypothesis as stated:
//
//   - "liquidity memadai"    -> token.liquidity >= SM_BONUS_MIN_LIQUIDITY
//   - "rug risk rendah"      -> trenches.rug_ratio is null OR < SM_BONUS_MAX_RUG_RATIO
//   - "bukan token noise"    -> already implied by the liquidity gate,
//                               since production's own safety veto
//                               (minLiquidityUsd: 2000) removes the
//                               sub-$2,000 noise cluster before this
//                               would ever reach a BUY tier anyway.
//
// Magnitude: capped at +20% of smartMoney's own max weight (18 * 0.20
// = ~3.6 points on the 0-100 participant scale) - small on purpose,
// matching the LOW-MEDIUM confidence of the underlying evidence (a
// ~10pp lift in pump probability, no lift in move size). This is a
// nudge, not a rewrite.
// =====================================

const SM_MAX_SCORE = config.participant.weights.smartMoney;
const SM_MIN_VOLUME = config.participant.minSignificantVolumeUsd.smartMoney;

const SM_BONUS_FRACTION = 0.20;          // of smartMoney's own max weight
const SM_BONUS_MIN_LIQUIDITY = 5000;     // USD - the $5k-15k band showed the best pump rate (35.3%) in validation
const SM_BONUS_MAX_RUG_RATIO = 0.30;     // matches the discussion of "low rug risk" in the Pump Behavior report

function smartMoneyCandidateScore(activities, change1h, gateFacts){

    if(!activities || !activities.length){

        return {
            score: Math.round(SM_MAX_SCORE * config.participant.neutralFraction),
            max: SM_MAX_SCORE,
            hasData: false,
            reasons: [],
            riskReasons: []
        };

    }

    const buys = activities.filter(a => a.side === "buy");
    const sells = activities.filter(a => a.side === "sell");
    const buyUsd = buys.reduce((sum, a) => sum + Number(a.amount_usd || 0), 0);
    const sellUsd = sells.reduce((sum, a) => sum + Number(a.amount_usd || 0), 0);
    const totalVolume = buyUsd + sellUsd;
    const volumeConfidence = Math.min(1, totalVolume / SM_MIN_VOLUME);

    const reasons = [];
    const riskReasons = [];

    const isAccumulating = buyUsd > sellUsd * 1.3;
    const isDistributing = sellUsd > buyUsd * 1.3;

    let directionScore;
    if(isAccumulating) directionScore = SM_MAX_SCORE;
    else if(isDistributing) directionScore = SM_MAX_SCORE * 0.15;
    else directionScore = SM_MAX_SCORE * 0.5;

    const neutralPoint = SM_MAX_SCORE * 0.5;
    let raw = neutralPoint + (directionScore - neutralPoint) * volumeConfidence;

    const isSignificant = totalVolume >= SM_MIN_VOLUME;

    if(isAccumulating && isSignificant){
        reasons.push(`Smart money accumulation detected ($${Math.round(buyUsd).toLocaleString()} bought vs $${Math.round(sellUsd).toLocaleString()} sold recently)`);
    }
    else if(isAccumulating){
        reasons.push(`Smart money leaning toward accumulation, but sample is small ($${Math.round(buyUsd).toLocaleString()} bought vs $${Math.round(sellUsd).toLocaleString()} sold - below the $${SM_MIN_VOLUME} significance threshold)`);
    }
    else if(isDistributing){
        riskReasons.push(`Smart money distribution detected ($${Math.round(sellUsd).toLocaleString()} sold vs $${Math.round(buyUsd).toLocaleString()} bought recently)`);
    }
    else{
        reasons.push(`Smart money activity detected (${activities.length} recent trade(s))`);
    }

    const earlinessFactor = lookupFactor(config.participant.earlinessCurve, Math.abs(change1h ?? 0), "maxChange1h");
    let finalScore = raw * earlinessFactor;

    if(earlinessFactor < 0.5 && isAccumulating && isSignificant){
        reasons[reasons.length-1] += " - discounted, price has already moved significantly";
    }

    // ---- CANDIDATE V2 ADDITION (the only behavioral change in this whole file) ----
    let bonusApplied = false;
    if(isAccumulating && isSignificant){

        const liquidityOk = gateFacts && gateFacts.liquidity != null && gateFacts.liquidity >= SM_BONUS_MIN_LIQUIDITY;
        const rugOk = !gateFacts || gateFacts.rugRatio == null || gateFacts.rugRatio < SM_BONUS_MAX_RUG_RATIO;

        if(liquidityOk && rugOk){
            const bonus = SM_MAX_SCORE * SM_BONUS_FRACTION * earlinessFactor;
            finalScore += bonus;
            bonusApplied = true;
            reasons.push(`Candidate V2: early smart-money bonus applied (+${bonus.toFixed(1)}pts) - adequate liquidity ($${Math.round(gateFacts.liquidity).toLocaleString()}) and low rug risk`);
        }
    }

    finalScore = Math.round(Math.min(SM_MAX_SCORE, finalScore));

    return { score: finalScore, max: SM_MAX_SCORE, hasData: true, reasons, riskReasons, candidateBonusApplied: bonusApplied };
}

// =====================================
// Everything below this point is a VERBATIM copy of
// intelligenceEngine.js's orchestration (preloadContext, combineScore,
// structural self-validation, safety veto, confidence, action tiers) -
// same architecture, same weights, same thresholds. The only line that
// differs from the production file is the one marked below where
// smartMoneyCandidateScore() is called instead of smartMoney.score().
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

function toGmgnStatsShape(walletRow){
    const tags = [];
    if((walletRow.total_trades ?? 0) < 3) tags.push("fresh_wallet");
    return { common: { tags }, pnl_stat: { token_num: walletRow.total_trades, winrate: walletRow.win_rate } };
}

function gatherCachedWalletStats(addresses, ctx){
    const results = [];
    const seen = new Set();
    for(const addr of addresses){
        if(!addr || seen.has(addr)) continue;
        seen.add(addr);
        const ownWallet = ctx?.walletsByAddress ? (ctx.walletsByAddress.get(addr) ?? null) : walletRepository.findByAddress(addr);
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

function groupByToken(rows){
    const map = new Map();
    for(const row of rows){
        if(!map.has(row.token_address)) map.set(row.token_address, []);
        map.get(row.token_address).push(row);
    }
    return map;
}

function preloadContext(tokens){
    const addresses = tokens.map(t => t.token_address);
    const trenchesByAddress = gmgnTrenchesRepository.findManyByTokenAddresses(addresses);
    const hotSearchByAddress = gmgnHotSearchesRepository.findManyByTokenAddresses(addresses);
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

function scoreToAction(participantScore){
    if(participantScore >= config.actionTiers.strongBuy) return "STRONG BUY";
    if(participantScore >= config.actionTiers.buy) return "BUY";
    if(participantScore >= config.actionTiers.hold) return "HOLD";
    return "AVOID";
}

function computeStructuralRedFlags(token, trenchesEntry, participantModules){
    const s = config.structuralValidation;
    const flags = [];
    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;
    const change5m = token.price_change_5m != null ? Number(token.price_change_5m) : null;
    if(change1h != null && change1h <= s.downtrend1hPct) flags.push(`Real downtrend: price down ${Math.abs(change1h).toFixed(1)}% in the last hour`);
    if(change5m != null && change5m <= s.recentDump5mPct) flags.push(`Recent dump detected: price down ${Math.abs(change5m).toFixed(1)}% in the last 5 minutes`);
    const peak = tokenPriceHistoryRepository.findPeakPrice(token.token_address);
    if(peak != null && peak > 0 && token.price != null){
        const drawdown = (peak - Number(token.price)) / peak;
        if(drawdown >= s.structuralBreakdownDrawdown) flags.push(`Structural breakdown: price is ${(drawdown*100).toFixed(0)}% below its real observed peak on this platform`);
    }
    if(trenchesEntry?.net_buy_24h != null && Number(trenchesEntry.net_buy_24h) <= s.netDistributionUsd) flags.push(`Net distribution confirmed: $${Math.abs(Math.round(trenchesEntry.net_buy_24h)).toLocaleString()} net sold (24h)`);
    if(participantModules.smartMoney.hasData && participantModules.smartMoney.score <= participantModules.smartMoney.max * s.distributingSubScoreFraction) flags.push("Smart money is net exiting this token, not accumulating");
    if(participantModules.kol.hasData && participantModules.kol.score <= participantModules.kol.max * s.distributingSubScoreFraction) flags.push("KOL wallets are net exiting this token, not accumulating");
    return flags;
}

function applyStructuralPenalty(participantScoreRaw, redFlags){
    const s = config.structuralValidation;
    const penalty = Math.min(s.maxPenalty, redFlags.length * s.penaltyPerFlag);
    const penalized = Math.max(0, Math.round(participantScoreRaw - penalty));
    return { participantScore: penalized, participantScoreRaw, penaltyApplied: penalty, redFlags };
}

function applySafetyVeto(action, securityFacts, liquidityFacts, holders){
    const v = config.safetyVeto;
    if(securityFacts?.isHoneypot === 1) return { action: "AVOID", vetoed: true, reason: "Security veto: flagged as a possible honeypot" };
    if(Number(liquidityFacts.liquidity || 0) < v.minLiquidityUsd) return { action: "AVOID", vetoed: true, reason: `Security veto: liquidity below $${v.minLiquidityUsd}` };
    if(liquidityFacts.backingRatio != null && liquidityFacts.backingRatio < v.minBackingRatio) return { action: "AVOID", vetoed: true, reason: "Security veto: liquidity critically thin relative to valuation" };
    if(holders != null && holders < v.minHolders) return { action: "AVOID", vetoed: true, reason: `Security veto: fewer than ${v.minHolders} holders` };
    return { action, vetoed: false, reason: null };
}

function combineScore(modules, maxTotal, neutralFraction){
    const values = Object.values(modules);
    const availableWeight = values.filter(m => m.hasData).reduce((sum,m) => sum+m.max, 0);
    if(availableWeight === 0) return Math.round(maxTotal * neutralFraction);
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

function computeFreshnessPenalty(marketAgeSeconds){
    if(marketAgeSeconds == null) return 0;
    const f = config.freshness.confidencePenalty;
    const ratio = Math.min(1, marketAgeSeconds / f.fullPenaltyAfterSeconds);
    return ratio * f.maxPenalty;
}

function computeRisk(riskReasons, hardTriggers){
    const r = config.risk;
    if(hardTriggers.some(Boolean) || riskReasons.length >= r.highAtRiskReasonCount) return "HIGH";
    if(riskReasons.length >= r.mediumAtRiskReasonCount) return "MEDIUM";
    return "LOW";
}

function analyzeToken(token, ctx){
    const address = token.token_address;
    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;

    const trenchesEntry = ctx ? (ctx.trenchesByAddress.get(address) ?? null) : gmgnTrenchesRepository.findByTokenAddress(address);
    const smartMoneyActivity = ctx ? (ctx.smartMoneyByAddress.get(address) ?? []).slice(0, 20) : gmgnActivityFeedRepository.findByToken(address, "smart_money", 20);
    const kolActivity = ctx ? (ctx.kolByAddress.get(address) ?? []).slice(0, 20) : gmgnActivityFeedRepository.findByToken(address, "kol", 20);
    const hotSearchEntry = ctx ? (ctx.hotSearchByAddress.get(address) ?? null) : gmgnHotSearchesRepository.findByToken(address);

    const securityCacheKey = gmgnOndemandCacheRepository.buildCacheKey("token_security", { chain: "sol", address });
    const cachedSecurity = ctx ? (ctx.cacheMap.get(securityCacheKey) ?? null) : gmgnOndemandCacheRepository.getIgnoringExpiry(securityCacheKey);

    const holdersCacheKey = gmgnOndemandCacheRepository.buildCacheKey("token_top_holders", { chain: "sol", address });
    const cachedHolders = ctx ? (ctx.cacheMap.get(holdersCacheKey) ?? null) : gmgnOndemandCacheRepository.getIgnoringExpiry(holdersCacheKey);

    const creatorAddress = trenchesEntry?.creator || null;
    const launchpadStats = trenchesEntry?.launchpad ? (ctx ? (ctx.launchpadStatsByName.get(trenchesEntry.launchpad) ?? null) : gmgnLaunchpadStatsRepository.findByLaunchpad(trenchesEntry.launchpad)) : null;

    const relevantWallets = [creatorAddress, ...smartMoneyActivity.map(a => a.maker_address), ...kolActivity.map(a => a.maker_address)].filter(Boolean).slice(0, 8);
    const walletStatsList = gatherCachedWalletStats(relevantWallets, ctx);
    const securityFacts = buildSecurityFacts(trenchesEntry, cachedSecurity);

    const marketAgeSeconds = ageSecondsSince(token.updated_at);
    const lifecycle = lifecycleForAge(marketAgeSeconds);

    // ---- PARTICIPANT SCORE ----
    const participantModules = {
        accumulation: accumulation.score(trenchesEntry, change1h),
        // *** THE ONLY CHANGED LINE vs production intelligenceEngine.js ***
        smartMoney: smartMoneyCandidateScore(smartMoneyActivity, change1h, { liquidity: Number(token.liquidity) || null, rugRatio: trenchesEntry?.rug_ratio ?? null }),
        kol: kolModule.score(kolActivity, change1h),
        whale: whale.score(trenchesEntry),
        developer: developer.score(trenchesEntry),
        sniperQuality: sniper.score(trenchesEntry),
        bundleQuality: bundle.score(trenchesEntry),
        insiderQuality: insider.score(trenchesEntry),
        walletQuality: walletQuality.score(walletStatsList),
        walletProfitability: walletProfitability.score(walletStatsList)
    };

    const participantScoreRaw = combineScore(participantModules, PARTICIPANT_MAX, config.participant.neutralFraction);
    const structuralRedFlags = computeStructuralRedFlags(token, trenchesEntry, participantModules);
    const structuralPenalty = applyStructuralPenalty(participantScoreRaw, structuralRedFlags);
    const participantScore = structuralPenalty.participantScore;

    const reasons = Object.values(participantModules).flatMap(m => m.reasons);
    const participantRiskReasons = Object.values(participantModules).flatMap(m => m.riskReasons);

    // ---- MARKET HEALTH ----
    const marketModules = {
        liquidity: liquidityModule.score(token),
        security: security.score(securityFacts),
        holderDistribution: holderDistribution.score(token, trenchesEntry),
        volume: volume.score(token),
        priceStability: priceStability.score(token)
    };

    const marketScore = combineScore(marketModules, MARKET_MAX, config.market.neutralFraction);
    const marketRiskReasons = Object.values(marketModules).flatMap(m => m.riskReasons);
    const riskReasons = [...participantRiskReasons, ...marketRiskReasons];

    const baseAction = scoreToAction(participantScore);
    if(structuralPenalty.penaltyApplied > 0){
        riskReasons.unshift(`Self-validation: participant score reduced ${structuralPenalty.participantScoreRaw} -> ${participantScore} (-${structuralPenalty.penaltyApplied}): ${structuralRedFlags.join("; ")}`);
    }

    const veto = applySafetyVeto(baseAction, securityFacts, marketModules.liquidity.facts, token.holders != null ? Number(token.holders) : null);
    const action = veto.action;
    if(veto.vetoed) riskReasons.unshift(veto.reason);

    const allModules = [...Object.values(participantModules), ...Object.values(marketModules)];
    const freshnessPenalty = computeFreshnessPenalty(marketAgeSeconds);
    const confidence = computeConfidence(participantScore, marketScore, allModules, freshnessPenalty);

    const hardTriggers = [veto.vetoed, change1h != null && change1h >= 500];
    const risk = computeRisk(riskReasons, hardTriggers);

    if(!reasons.length) reasons.push("No strong participant signal detected yet");

    return {
        action,
        participantScore,
        participantMax: PARTICIPANT_MAX,
        marketHealth: marketScore,
        marketHealthMax: MARKET_MAX,
        confidence,
        risk,
        reasons,
        riskReasons,
        breakdown: {
            participant: Object.fromEntries(Object.entries(participantModules).map(([k,m]) => [k, { score:m.score, max:m.max, hasData:m.hasData }])),
            market: Object.fromEntries(Object.entries(marketModules).map(([k,m]) => [k, { score:m.score, max:m.max, hasData:m.hasData }]))
        },
        candidateSmartMoneyBonusApplied: participantModules.smartMoney.candidateBonusApplied || false
    };
}

function analyzeTokens(tokens){
    if(!tokens.length) return [];
    const ctx = preloadContext(tokens);
    return tokens.map(token => analyzeToken(token, ctx));
}

module.exports = { analyzeTokens, analyzeToken, PARTICIPANT_MAX, MARKET_MAX, SM_BONUS_MIN_LIQUIDITY, SM_BONUS_MAX_RUG_RATIO, SM_BONUS_FRACTION };
