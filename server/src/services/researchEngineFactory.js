// services/researchEngineFactory.js - ENGINE TOURNAMENT research
// infrastructure (research/shadow use only, never wired into any
// route, scheduler, or prediction write path). PRODUCTION remains
// intelligenceEngine.js, completely unmodified and untouched.
//
// Each exported engine is a distinct, named PHILOSOPHY with an
// explicit stated hypothesis (see PHILOSOPHIES below), implemented as
// a weight-multiplier + threshold override on top of production's
// REAL, UNMODIFIED sub-modules - never a rewrite of scoring logic
// itself. A multiplier scales a module's `score` AND `max` by the same
// factor, which preserves that module's own percent-fill (its
// internal logic is untouched) while changing how much it influences
// combineScore()'s weighted renormalization - i.e. this only changes
// how much each already-real signal COUNTS, never what the signal
// itself says.
//
// preloadContext() (DB batch reads) is run ONCE per cycle and shared
// across every philosophy - only the small in-memory weighting/tier
// arithmetic differs between them, so running all 12 costs a small
// fraction more than running Production alone.

const config = require("../config/scoringConfig");
const { lookupFactor } = require("./intelligence/curveHelper");

const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const gmgnActivityFeedRepository = require("../repositories/gmgnActivityFeedRepository");
const gmgnHotSearchesRepository = require("../repositories/gmgnHotSearchesRepository");
const gmgnLaunchpadStatsRepository = require("../repositories/gmgnLaunchpadStatsRepository");
const gmgnOndemandCacheRepository = require("../repositories/gmgnOndemandCacheRepository");
const walletRepository = require("../repositories/walletRepository");
const tokenPriceHistoryRepository = require("../repositories/tokenPriceHistoryRepository");

const accumulation = require("./intelligence/participant/accumulation");
const smartMoney = require("./intelligence/participant/smartMoney");
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
// SHARED PRELOAD (identical to intelligenceEngine.js's preloadContext)
// =====================================

function groupByToken(rows){
    const map = new Map();
    for(const row of rows){
        if(!map.has(row.token_address)) map.set(row.token_address, []);
        map.get(row.token_address).push(row);
    }
    return map;
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
        const ownWallet = ctx.walletsByAddress.get(addr) ?? null;
        if(ownWallet && ownWallet.total_trades > 0 && ownWallet.win_rate != null){
            results.push(toGmgnStatsShape(ownWallet));
            continue;
        }
        const key = gmgnOndemandCacheRepository.buildCacheKey("wallet_stats", { chain: "sol", walletAddress: addr });
        const cached = ctx.cacheMap.get(key) ?? null;
        if(cached?.data) results.push(cached.data);
    }
    return results;
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

function buildSecurityFacts(trenchesEntry, cachedSecurity){
    if(trenchesEntry){
        return { isHoneypot: trenchesEntry.is_honeypot, renouncedMint: trenchesEntry.renounced_mint, renouncedFreezeAccount: trenchesEntry.renounced_freeze_account, rugRatio: trenchesEntry.rug_ratio, source: "trenches" };
    }
    if(cachedSecurity?.data){
        const d = cachedSecurity.data;
        return { isHoneypot: d.is_honeypot === true ? 1 : (d.is_honeypot === false ? 0 : (d.honeypot ? 1 : null)), renouncedMint: d.renounced_mint === true ? 1 : (d.renounced_mint === false ? 0 : null), renouncedFreezeAccount: d.renounced_freeze_account === true ? 1 : (d.renounced_freeze_account === false ? 0 : null), rugRatio: null, source: "on-demand cache" };
    }
    return null;
}

function ageSecondsSince(timestamp){
    if(!timestamp) return null;
    const then = new Date(`${String(timestamp).replace(" ", "T")}Z`).getTime();
    if(Number.isNaN(then)) return null;
    return Math.max(0, (Date.now() - then) / 1000);
}

function computeStructuralRedFlags(token, trenchesEntry, participantModules){
    const s = config.structuralValidation;
    const flags = [];
    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;
    const change5m = token.price_change_5m != null ? Number(token.price_change_5m) : null;
    if(change1h != null && change1h <= s.downtrend1hPct) flags.push("downtrend1h");
    if(change5m != null && change5m <= s.recentDump5mPct) flags.push("dump5m");
    const peak = tokenPriceHistoryRepository.findPeakPrice(token.token_address);
    if(peak != null && peak > 0 && token.price != null){
        const drawdown = (peak - Number(token.price)) / peak;
        if(drawdown >= s.structuralBreakdownDrawdown) flags.push("structuralBreakdown");
    }
    if(trenchesEntry?.net_buy_24h != null && Number(trenchesEntry.net_buy_24h) <= s.netDistributionUsd) flags.push("netDistribution");
    if(participantModules.smartMoney.hasData && participantModules.smartMoney.score <= participantModules.smartMoney.max * s.distributingSubScoreFraction) flags.push("smExiting");
    if(participantModules.kol.hasData && participantModules.kol.score <= participantModules.kol.max * s.distributingSubScoreFraction) flags.push("kolExiting");
    return flags;
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

// scale a module's score/max by the same factor - preserves % fill,
// changes its weighted influence in combineScore's renormalization.
function scaleModule(m, factor){
    if(factor === 1) return m;
    return { ...m, score: m.score * factor, max: m.max * factor };
}

// =====================================
// PHILOSOPHY DEFINITIONS - every override is named and justified.
// Unlisted fields default to production's real values (no change).
// =====================================

const PHILOSOPHIES = [

    {
        key: "production",
        name: "Production (V1)",
        hypothesis: "Benchmark - the real, currently-deployed engine, completely unmodified. Every other engine is measured against this.",
        weights: {}, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false
    },

    {
        key: "conservative",
        name: "Conservative",
        hypothesis: "Fewer, higher-conviction trades reduce false positives and drawdown even at the cost of trade count. Raises BUY/STRONG BUY thresholds and up-weights security+liquidity relative to timing-driven signals.",
        weights: { accumulation: 0.7, smartMoney: 0.7, kol: 0.7, security: 1.5, liquidity: 1.5 },
        tiers: { buy: 70, strongBuy: 88 }, minLiquidityUsd: null, flattenEarliness: false, smBonus: false
    },

    {
        key: "balanced",
        name: "Balanced (Redistributed)",
        hypothesis: "Production concentrates 50/100 participant weight into 3 timing-driven modules (accumulation+smartMoney+kol). A flatter distribution across all 10 modules may generalize better instead of overfitting to a narrow timing signal.",
        weights: { accumulation: 0.5, smartMoney: 0.56, kol: 0.83, whale: 1.0, developer: 1.0, sniperQuality: 1.25, bundleQuality: 1.43, insiderQuality: 2.0, walletQuality: 2.0, walletProfitability: 2.0 },
        tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false
    },

    {
        key: "aggressive",
        name: "Aggressive",
        hypothesis: "scoringConfig.js's own comments call the buy=62/strongBuy=80 thresholds 'a deliberate policy tightening, not a new data-validated number.' Reverting toward the original, looser thresholds may recover trade volume/profit lost by being overly selective.",
        weights: {}, tiers: { buy: 52, strongBuy: 70 }, minLiquidityUsd: null, flattenEarliness: false, smBonus: false
    },

    {
        key: "superAggressive",
        name: "Super Aggressive",
        hypothesis: "Push both the action-tier floor and the safety-veto liquidity floor down hard. Explicitly expected to carry the highest risk of ruin - included to test whether the tournament's downside is allowed to play out honestly, not to be flattered.",
        weights: {}, tiers: { buy: 42, strongBuy: 60 }, minLiquidityUsd: 1000, flattenEarliness: false, smBonus: false
    },

    {
        key: "momentumHunter",
        name: "Momentum Hunter",
        hypothesis: "Direct adversarial test of production's own core philosophy: scoringConfig.js says a token that already ran is 'far more likely to be late FOMO.' This engine removes the earliness discount entirely (factor pinned to 1.0) to test whether that assumption actually costs profit in practice.",
        weights: {}, tiers: {}, minLiquidityUsd: null, flattenEarliness: true, smBonus: false
    },

    {
        key: "earlySmartMoney",
        name: "Early Smart Money",
        hypothesis: "Motivated directly by this sprint's timing-replay research: among real winners with a fair 30-minute observation window, smart money crossing its significance bar led the 'race' 57% of the time (28/49), almost always already present at the full 30-minute boundary. Up-weights smartMoney's influence 2.5x.",
        weights: { smartMoney: 2.5 }, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false
    },

    {
        key: "earlyHolderGrowth",
        name: "Early Holder Growth",
        hypothesis: "UNVALIDATED BY THE TIMING RESEARCH (holder count has no point-in-time history in this schema - only a current snapshot - so this hypothesis could not be tested backward the way Smart Money's was). Included per the requested philosophy list anyway; up-weights holderDistribution 3x as a genuinely speculative bet, disclosed as such upfront. ARCHITECTURAL NOTE: holderDistribution is a MARKET-side module - by this engine's own design, market health can never independently promote a token to BUY (only participant score drives action). This engine is therefore EXPECTED to enter the exact same tokens as Production; the only place it can differ is confidence (which can widen/narrow its native TP/SL via tradePlanService).",
        weights: { holderDistribution: 3.0 }, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false
    },

    {
        key: "walletExpansion",
        name: "Wallet Expansion",
        hypothesis: "walletQuality + walletProfitability (on-demand cached real wallet PNL/tag data) sit at just 5+5=10/100 weight today, and are the least-often-populated modules (cache is sparse). Tests whether up-weighting them 3x helps when they DO have data, without fabricating anything when they don't (unchanged hasData:false handling).",
        weights: { walletQuality: 3.0, walletProfitability: 3.0 }, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false
    },

    {
        key: "microCapHunter",
        name: "Micro Cap Hunter",
        hypothesis: "Smaller-cap tokens have more room to run percentage-wise. Lowers the hard safety-veto liquidity floor from production's $2,000 to $800 (admitting genuinely tiny-liquidity tokens that production vetoes outright to AVOID) and de-weights liquidity's market-health influence 0.3x. NOTE: this directly contradicts this sprint's own Pump Behavior Analysis validation, which found the $5k-15k liquidity band outperformed both smaller and larger bands, and the earlier shadow test's own noise-cluster finding (sub-$25 liquidity tokens showing meaningless AMM-math swings) - included anyway as an honest adversarial test expected to risk real losses, not because the evidence favors it.",
        weights: { liquidity: 0.3 }, tiers: {}, minLiquidityUsd: 800, flattenEarliness: false, smBonus: false
    },

    {
        key: "volumeExplosion",
        name: "Volume Explosion",
        hypothesis: "Recent volume relative to liquidity is a real, already-collected signal (volume.js) sitting at only 10/100 market weight. Tests whether a sudden volume surge - independent of the smart-money/KOL wallet tagging system - is an under-used, cheaper-to-detect proxy for the same 'something is happening' signal. ARCHITECTURAL NOTE: same constraint as Early Holder Growth above - volume is a MARKET-side module, so this engine is EXPECTED to enter the exact same tokens as Production; only confidence (and therefore native TP/SL width) can differ.",
        weights: { volume: 3.0 }, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false
    },

    {
        key: "candidateV2",
        name: "Candidate V2 (Smart Money bonus, carried over)",
        hypothesis: "The exact engine built and shadow-tested for 30 minutes in the previous sprint (inconclusive - too small a sample: 0/5 additional flags won, but n was too small to confirm or deny). Carried into this 6-hour tournament for a much larger, fairer test of the same conditional smart-money bonus (liquidity>=$5,000, rug_ratio<30%, +20% of smartMoney's weight).",
        weights: {}, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: true
    },

    {
        key: "veryAggressive",
        name: "Very Aggressive",
        hypothesis: "A midpoint between Aggressive and Super Aggressive, kept as its own rung (not just interpolated after the fact) so the tournament can see whether profit scales smoothly with looser thresholds or peaks somewhere in the middle and falls off.",
        weights: {}, tiers: { buy: 47, strongBuy: 65 }, minLiquidityUsd: 1500, flattenEarliness: false, smBonus: false
    },

    {
        key: "breakoutHunter",
        name: "Breakout Hunter",
        hypothesis: "Believes a genuine breakout - price ALREADY accelerating upward on both the 5-minute and 1-hour window at once - is a distinct, more reliable pattern than accumulation-without-price-confirmation. Adds a hard entry gate on top of production's normal scoring: change_5m > 0 AND change_1h > 0 AND change_5m*12 > change_1h (5-minute pace annualized-to-hourly is outrunning the trailing hour, i.e. acceleration, not just drift).",
        weights: {}, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false,
        entryGate: (f) => f.change5m != null && f.change1h != null && f.change5m > 0 && f.change1h > 0 && (f.change5m * 12) > f.change1h
    },

    {
        key: "reversalHunter",
        name: "Reversal Hunter",
        hypothesis: "Believes tokens dipping over the last hour but already bouncing in the last 5 minutes are a real mean-reversion opportunity mispriced by momentum-chasers. Entry gate: change_1h < 0 (real down over the hour) AND change_5m > 0 (already turning up).",
        weights: {}, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false,
        entryGate: (f) => f.change1h != null && f.change5m != null && f.change1h < 0 && f.change5m > 0
    },

    {
        key: "liquidityExpansion",
        name: "Liquidity Expansion",
        hypothesis: "The mirror opposite of Micro Cap Hunter: believes DEEPER liquidity is worth paying up for because it confirms real conviction and reduces slippage/rug risk, even if it means paying a higher effective entry. Up-weights liquidity's market-health influence 2.5x (no threshold changes).",
        weights: { liquidity: 2.5 }, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false
    },

    {
        key: "whaleHunter",
        name: "Whale Hunter",
        hypothesis: "whale.js (concentration of smart/degen-tagged wallets among a token's flow) sits at only 10/100 weight today. Believes whale/smart-degen concentration is a more specific, harder-to-fake signal than raw net-buy flow. Up-weights whale's influence 3x.",
        weights: { whale: 3.0 }, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false
    },

    {
        key: "hybridAI",
        name: "Hybrid AI",
        hypothesis: "Believes no single specialist signal dominates, and that BLENDING several already-tested specialist theses (Early Smart Money + Volume Explosion + Whale Hunter, averaged against Production's own baseline weighting) outperforms any one of them alone. Implemented as the arithmetic mean of those four engines' own weight multipliers per module (a deterministic blend computed once, not a live per-token vote across engines) - smartMoney x1.375, volume x1.5, whale x1.5, everything else at Production's default.",
        weights: { smartMoney: 1.375, volume: 1.5, whale: 1.5 }, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false
    },

    {
        key: "confirmationFirst",
        name: "Confirmation First",
        hypothesis: "Production's architecture lets Market Health only VETO down, never independently require confirmation for a BUY. This engine tests the opposite design: participant score must clear the normal BUY bar AND market health must independently clear a 55/100 floor - real confirmation required from BOTH systems, not just an absence of a veto.",
        weights: {}, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false,
        entryGate: (f) => f.marketHealth >= 55
    },

    {
        key: "speedFirst",
        name: "Speed First",
        hypothesis: "This sprint's own shadow tests found ~89% of any given moment's BUY/STRONG BUY flags are stale, pre-existing scores, not fresh signals - meaning most 'engines' mostly re-discover old news. Speed First deliberately trades ONLY on tokens whose gmgn_tokens row was updated in the last 2 minutes (genuinely fresh this cycle) with a slightly loosened BUY bar (58 instead of 62), betting that reacting fast to truly new information beats a stricter bar applied to stale information.",
        weights: {}, tiers: { buy: 58 }, minLiquidityUsd: null, flattenEarliness: false, smBonus: false,
        entryGate: (f) => f.marketAgeSeconds != null && f.marketAgeSeconds <= 120
    },

    {
        key: "highPrecision",
        name: "High Precision",
        hypothesis: "Explicitly optimizes for minimizing false positives over catching every winner: raises the BUY bar to 75 (near production's own STRONG BUY floor) AND additionally requires risk to already compute as LOW - a token can score high but still get skipped here if it is flagged MEDIUM/HIGH risk by any module.",
        weights: {}, tiers: { buy: 75 }, minLiquidityUsd: null, flattenEarliness: false, smBonus: false,
        entryGate: (f) => f.risk === "LOW"
    },

    {
        key: "highRecall",
        name: "High Recall",
        hypothesis: "The mirror opposite of High Precision: explicitly optimizes for catching as many real winners as possible, accepting many more false positives as the cost. Lowest BUY bar in the league (40, just above HOLD) combined with a flattened earliness curve (no momentum discount at all).",
        weights: {}, tiers: { buy: 40, strongBuy: 58 }, minLiquidityUsd: null, flattenEarliness: true, smBonus: false
    },

    {
        key: "falsePositiveTolerant",
        name: "False Positive Tolerant",
        hypothesis: "Believes the 'quality/safety' inverse-risk modules (developer, sniperQuality, bundleQuality, insiderQuality - 30/100 weight combined) are mostly noise-suppression that also filters out real winners, and that pure flow/momentum (accumulation+smartMoney+kol) is what actually pays. De-weights all four quality modules to 0.3x, leaving thresholds at Production's default - explicitly willing to eat more false positives from tokens a quality filter would have blocked.",
        weights: { developer: 0.3, sniperQuality: 0.3, bundleQuality: 0.3, insiderQuality: 0.3 }, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false
    },

    {
        key: "falseNegativeTolerant",
        name: "False Negative Tolerant",
        hypothesis: "The mirror opposite of False Positive Tolerant: believes the quality/safety modules are UNDER-weighted today and worth prioritizing even if it means passing on real winners that don't clear a safety bar. Up-weights developer/sniperQuality/bundleQuality/insiderQuality 2x while down-weighting the timing-driven flow modules (accumulation/smartMoney/kol) to 0.5x.",
        weights: { developer: 2.0, sniperQuality: 2.0, bundleQuality: 2.0, insiderQuality: 2.0, accumulation: 0.5, smartMoney: 0.5, kol: 0.5 }, tiers: {}, minLiquidityUsd: null, flattenEarliness: false, smBonus: false
    }

];

const SM_BONUS_FRACTION = 0.20;
const SM_BONUS_MIN_LIQUIDITY = 5000;
const SM_BONUS_MAX_RUG_RATIO = 0.30;

function analyzeTokenWithPhilosophy(token, ctx, philosophy){
    const address = token.token_address;
    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;

    const trenchesEntry = ctx.trenchesByAddress.get(address) ?? null;
    const smartMoneyActivity = (ctx.smartMoneyByAddress.get(address) ?? []).slice(0, 20);
    const kolActivity = (ctx.kolByAddress.get(address) ?? []).slice(0, 20);

    const securityCacheKey = gmgnOndemandCacheRepository.buildCacheKey("token_security", { chain: "sol", address });
    const cachedSecurity = ctx.cacheMap.get(securityCacheKey) ?? null;
    const creatorAddress = trenchesEntry?.creator || null;

    const relevantWallets = [creatorAddress, ...smartMoneyActivity.map(a => a.maker_address), ...kolActivity.map(a => a.maker_address)].filter(Boolean).slice(0, 8);
    const walletStatsList = gatherCachedWalletStats(relevantWallets, ctx);
    const securityFacts = buildSecurityFacts(trenchesEntry, cachedSecurity);

    const marketAgeSeconds = ageSecondsSince(token.updated_at);

    const w = philosophy.weights || {};
    const effectiveChange1h = philosophy.flattenEarliness ? 0 : change1h; // factor lookup uses |value| - 0 always hits the first (1.00) bucket

    let smScore;
    if(philosophy.smBonus){
        smScore = smartMoney.score(smartMoneyActivity, effectiveChange1h);
        if(smScore.hasData){
            const buys = smartMoneyActivity.filter(a => a.side === "buy").reduce((s,a) => s + Number(a.amount_usd||0), 0);
            const sells = smartMoneyActivity.filter(a => a.side === "sell").reduce((s,a) => s + Number(a.amount_usd||0), 0);
            const isAccumulating = buys > sells * 1.3;
            const isSignificant = (buys+sells) >= config.participant.minSignificantVolumeUsd.smartMoney;
            const liquidityOk = Number(token.liquidity) >= SM_BONUS_MIN_LIQUIDITY;
            const rugOk = trenchesEntry?.rug_ratio == null || trenchesEntry.rug_ratio < SM_BONUS_MAX_RUG_RATIO;
            if(isAccumulating && isSignificant && liquidityOk && rugOk){
                const earlinessFactor = lookupFactor(config.participant.earlinessCurve, Math.abs(effectiveChange1h ?? 0), "maxChange1h");
                smScore = { ...smScore, score: Math.min(smScore.max, smScore.score + smScore.max * SM_BONUS_FRACTION * earlinessFactor) };
            }
        }
    } else {
        smScore = smartMoney.score(smartMoneyActivity, effectiveChange1h);
    }

    const participantModules = {
        accumulation: scaleModule(accumulation.score(trenchesEntry, effectiveChange1h), w.accumulation ?? 1),
        smartMoney: scaleModule(smScore, w.smartMoney ?? 1),
        kol: scaleModule(kolModule.score(kolActivity, effectiveChange1h), w.kol ?? 1),
        whale: scaleModule(whale.score(trenchesEntry), w.whale ?? 1),
        developer: scaleModule(developer.score(trenchesEntry), w.developer ?? 1),
        sniperQuality: scaleModule(sniper.score(trenchesEntry), w.sniperQuality ?? 1),
        bundleQuality: scaleModule(bundle.score(trenchesEntry), w.bundleQuality ?? 1),
        insiderQuality: scaleModule(insider.score(trenchesEntry), w.insiderQuality ?? 1),
        walletQuality: scaleModule(walletQuality.score(walletStatsList), w.walletQuality ?? 1),
        walletProfitability: scaleModule(walletProfitability.score(walletStatsList), w.walletProfitability ?? 1)
    };

    const participantScoreRaw = combineScore(participantModules, PARTICIPANT_MAX, config.participant.neutralFraction);
    const structuralRedFlags = computeStructuralRedFlags(token, trenchesEntry, participantModules);
    const penalty = Math.min(config.structuralValidation.maxPenalty, structuralRedFlags.length * config.structuralValidation.penaltyPerFlag);
    const participantScore = Math.max(0, Math.round(participantScoreRaw - penalty));

    const reasons = Object.values(participantModules).flatMap(m => m.reasons || []);
    const participantRiskReasons = Object.values(participantModules).flatMap(m => m.riskReasons || []);

    const marketModules = {
        liquidity: scaleModule(liquidityModule.score(token), w.liquidity ?? 1),
        security: scaleModule(security.score(securityFacts), w.security ?? 1),
        holderDistribution: scaleModule(holderDistribution.score(token, trenchesEntry), w.holderDistribution ?? 1),
        volume: scaleModule(volume.score(token), w.volume ?? 1),
        priceStability: scaleModule(priceStability.score(token), w.priceStability ?? 1)
    };

    const marketScore = combineScore(marketModules, MARKET_MAX, config.market.neutralFraction);
    const marketRiskReasons = Object.values(marketModules).flatMap(m => m.riskReasons || []);
    const riskReasons = [...participantRiskReasons, ...marketRiskReasons];

    const tiers = { ...config.actionTiers, ...(philosophy.tiers || {}) };
    let action;
    if(participantScore >= tiers.strongBuy) action = "STRONG BUY";
    else if(participantScore >= tiers.buy) action = "BUY";
    else if(participantScore >= tiers.hold) action = "HOLD";
    else action = "AVOID";

    // safety veto (liquidity floor overridable per philosophy; everything else identical to production)
    const minLiq = philosophy.minLiquidityUsd ?? config.safetyVeto.minLiquidityUsd;
    let vetoed = false;
    if(securityFacts?.isHoneypot === 1){ action = "AVOID"; vetoed = true; }
    else if(Number(marketModules.liquidity.facts?.liquidity ?? token.liquidity ?? 0) < minLiq){ action = "AVOID"; vetoed = true; }
    else if(marketModules.liquidity.facts?.backingRatio != null && marketModules.liquidity.facts.backingRatio < config.safetyVeto.minBackingRatio){ action = "AVOID"; vetoed = true; }
    else if(token.holders != null && Number(token.holders) < config.safetyVeto.minHolders){ action = "AVOID"; vetoed = true; }

    const allModules = [...Object.values(participantModules), ...Object.values(marketModules)];
    const freshnessPenalty = computeFreshnessPenalty(marketAgeSeconds);
    const confidence = computeConfidence(participantScore, marketScore, allModules, freshnessPenalty);
    const hardTriggers = [vetoed, change1h != null && change1h >= 500];
    const risk = computeRisk(riskReasons, hardTriggers);

    // entry gate: an ADDITIONAL, philosophy-specific requirement beyond
    // the normal score/tier/veto pipeline above. If present and it
    // fails, a would-be BUY/STRONG BUY is downgraded to HOLD (the
    // underlying score/reasoning stands - this philosophy just declines
    // to act on it this cycle, same as a real trader passing on a setup
    // that doesn't meet their own additional criteria).
    if(philosophy.entryGate && (action === "BUY" || action === "STRONG BUY")){
        const change5m = token.price_change_5m != null ? Number(token.price_change_5m) : null;
        const gatePassed = philosophy.entryGate({ change1h, change5m, marketHealth: marketScore, risk, marketAgeSeconds, participantScore });
        if(!gatePassed) action = "HOLD";
    }

    return {
        action, participantScore, participantMax: PARTICIPANT_MAX, marketHealth: marketScore, marketHealthMax: MARKET_MAX,
        confidence, risk, reasons: reasons.length ? reasons : ["No strong participant signal detected yet"],
        breakdown: {
            participant: Object.fromEntries(Object.entries(participantModules).map(([k,m]) => [k, { score:m.score, max:m.max, hasData:m.hasData }])),
            market: Object.fromEntries(Object.entries(marketModules).map(([k,m]) => [k, { score:m.score, max:m.max, hasData:m.hasData }]))
        },
        // Minimal intelligence sub-object - only the fields real consumers in the
        // live prediction-creation path (predictionValidationService.js's
        // buildWalletSummary) actually read. NOT the full rich shape
        // intelligenceEngine.js's real analyzeToken returns (security/holders/
        // trenches/hotSearches/launchpad/walletActivity) - other direct callers of
        // intelligenceEngine.js elsewhere in the app (e.g. GET /token/:address) are
        // out of scope for this engine-swap and keep calling intelligenceEngine.js
        // directly, unaffected.
        intelligence: {
            smartMoney: { hasData: smartMoneyActivity.length > 0, activities: smartMoneyActivity },
            kol: { hasData: kolActivity.length > 0, activities: kolActivity },
            devWallet: creatorAddress ? { hasData: true, address: creatorAddress } : { hasData: false },
            walletStatsChecked: walletStatsList.length
        }
    };
}

function buildEngines(){
    return PHILOSOPHIES.map(philosophy => ({
        key: philosophy.key,
        name: philosophy.name,
        hypothesis: philosophy.hypothesis,
        analyzeTokens(tokens, ctx){
            return tokens.map(token => analyzeTokenWithPhilosophy(token, ctx, philosophy));
        }
    }));
}

module.exports = { buildEngines, preloadContext, PHILOSOPHIES };
