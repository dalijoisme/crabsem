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

// False Positive Reduction V2, Priority 5 (observability): a plain-
// language label per module, used only to render `missingEvidence` below
// - never read by any decision logic. Every module already has a
// hasData flag; this just names it for a human.
const MODULE_LABELS = {
    accumulation: "Net buy/sell flow", smartMoney: "Smart-money trade activity", kol: "KOL trade activity",
    whale: "Smart/degen wallet concentration", developer: "Developer track record", sniperQuality: "Sniper-bot concentration",
    bundleQuality: "Bundled/coordinated trading", insiderQuality: "Suspected-insider holdings", walletQuality: "Involved-wallet quality",
    walletProfitability: "Involved-wallet historical PNL", liquidity: "Liquidity depth", security: "Security facts (honeypot/renounce/rug ratio)",
    holderDistribution: "Holder count/concentration", volume: "1h trading volume", priceStability: "Price stability"
};

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

// False Positive Reduction V2, Priority 1: every sub-module already
// returns a real, non-fabricated neutral score (MAX_SCORE * neutralFraction,
// ~40% of its own max) when it has no real data - see e.g.
// intelligence/participant/smartMoney.js's own hasData:false branch. Before
// this sprint, combineScore discarded that neutral value entirely and
// EXCLUDED the module from both the numerator and denominator of the
// weighted average - which silently renormalizes the remaining modules'
// weight up to fill the gap, so "no data" ended up contributing NOTHING
// to the score rather than dragging it toward neutral. For a profile that
// up-weights exactly the modules most likely to be missing on a fresh
// token (AGGRESSIVE: smartMoney x1.8, kol x1.4), this meant the two
// modules the profile trusts most could be silently absent with zero
// score impact, while the remaining modules (several of which default
// toward FULL marks on mere absence-of-bad-evidence - see sniperQuality.js/
// bundleQuality.js/insiderQuality.js) counted for proportionally MORE of
// the total. Real proof (this account's own two real BUYs, replayed):
// MOON's participantScore was 77 with smartMoney/kol/walletQuality/
// walletProfitability all hasData:false; correctly included at their own
// real neutral scores instead of excluded, it recomputes to 56 - below
// AGGRESSIVE's own strongBuy floor (75) and barely above its buy floor
// (55). Fukuruto: 79 -> 58, the same direction. No module's own scoring
// logic changed - only how a module with nothing real to say is folded
// into the aggregate. Same function, same signature, used for both
// PARTICIPANT and MARKET scores - no weight, tier, or philosophy value
// changed anywhere in scoringConfig.js or strategyProfileConfig.js.
function combineScore(modules, maxTotal, neutralFraction){
    const values = Object.values(modules);
    const totalWeight = values.reduce((sum,m) => sum+m.max, 0);
    if(totalWeight === 0) return Math.round(maxTotal * neutralFraction);
    const totalScore = values.reduce((sum,m) => sum+m.score, 0);
    return Math.round((totalScore / totalWeight) * maxTotal);
}

// False Positive Reduction V2, Priority 3 ("Sinkronkan confidence dengan
// risk"): before this sprint, confidence blended participant/market
// scores plus mismatch/completeness/freshness penalties, but never read
// `risk` at all - a token already classified HIGH risk (>=4 real red
// flags, or a parabolic hard trigger - config.risk, computeRisk below)
// could still report confidence indistinguishable from a genuinely clean
// token's. entryGateService's HIGH-risk gate (Production Stabilization
// V2) already stops such a token from being bought, but the SIGNAL
// itself - shown on the homepage, candidate cards, and every other
// consumer of analyzeToken/analyzeTokens - still displayed a falsely
// reassuring confidence number. riskConfidencePenalty is a new,
// consistent-scale addition to config.risk (same order of magnitude as
// the existing freshness penalty's 20-point max and the existing
// completeness penalty's 25-point max) - not a participant/market
// weight, not a Strategy Profile field, not a philosophy change.
// False Positive Reduction V2, Priority 5 (observability): returns the
// full penalty breakdown alongside the final number - every input that
// pulled confidence down from the raw blended value, named individually,
// so a real BUY can persist WHY its confidence is what it is instead of
// just the final figure. Purely additive to this function's existing
// arithmetic - the final `value` is computed exactly as before.
function computeConfidence(participantScore, marketScore, allModules, freshnessPenalty, risk){
    const c = config.confidence;
    const participantPct = participantScore / PARTICIPANT_MAX;
    const marketPct = marketScore / MARKET_MAX;
    const blended = 100 * (c.participantWeight*participantPct + c.marketWeight*marketPct);
    const mismatch = Math.abs(participantPct - marketPct) * 100;
    const mismatchPenalty = mismatch * c.mismatchPenaltyPerPoint;
    const completeness = allModules.filter(m => m.hasData).length / allModules.length;
    const completenessPenalty = (1 - completeness) * c.maxCompletenessPenalty;
    const riskPenalty = config.risk.confidencePenalty[risk] ?? 0;
    const value = Math.round(Math.min(c.max, Math.max(c.min, blended - mismatchPenalty - completenessPenalty - freshnessPenalty - riskPenalty)));
    return {
        value,
        blended: Math.round(blended * 10) / 10,
        mismatchPenalty: Math.round(mismatchPenalty * 10) / 10,
        completenessPenalty: Math.round(completenessPenalty * 10) / 10,
        freshnessPenalty: Math.round(freshnessPenalty * 10) / 10,
        riskPenalty
    };
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

// Early Momentum Hunter refactor (Aggressive Strategy Profile): every
// module above scores an ABSOLUTE, point-in-time state (total $ volume,
// total holder count, total liquidity $) - none of them measure a rate
// of change, and priceStability.js actively penalizes it. This computes
// a genuine RATE-OF-CHANGE signal instead, from real time-series data
// already being collected (never a fabricated "acceleration score"):
//   - priceAccel: 5-minute pace (annualized to an hourly rate) outrunning
//     the trailing 1h pace, same direction - gmgn_tokens.price_change_5m/
//     price_change_1h, ~99.96% coverage.
//   - flowAccel: smart-money + KOL buy-$ rate in the recent window vs the
//     prior window, from gmgn_activity_feed.tx_timestamp - the SAME
//     activities array smartMoney.js/kol.js already receive, just bucketed
//     by time instead of summed lifetime. Note: the feed only holds each
//     token's most recent ~20 trades (see smartMoneyActivity/kolActivity
//     slicing above), so a token far more active than that will under-
//     count its true prior-window volume - an honest sample-size caveat,
//     not a fabricated zero.
//   - liquidityAccel: current liquidity vs liquidity recentWindowMinutes
//     ago, from token_price_history's own ~20-40s-resolution snapshots.
// Deliberately NOT built here (flagged, not faked): buyer/transaction
// acceleration (gmgn_tokens.volume_5m/buys_5m/sells_5m are populated on
// well under 1% of live rows - not usable) and whale/holder-count
// acceleration (gmgn_trenches is overwritten in place, no history
// retained). Returns null when `accel` (philosophy.acceleration) is
// absent - Baseline/Stable/Balanced never set it, so this is skipped
// entirely for them.
function computeAccelerationSignal(token, trenchesEntry, smartMoneyActivity, kolActivity, accel){

    if(!accel) return null;

    const change5m = token.price_change_5m != null ? Number(token.price_change_5m) : null;
    const change1h = token.price_change_1h != null ? Number(token.price_change_1h) : null;

    // Investigated this sprint: change5m === change1h exactly, in every
    // one of the real BUYs examined so far (Fukuruto, MOON, FEPE, KOSPI -
    // all real losers or unresolved). Considered treating this as a
    // data-integrity defect (single stale snapshot read into both
    // fields) and suppressing priceAccel when it occurs. Deliberately
    // NOT implemented: a direct population query (gmgn_tokens, this
    // sprint) found this exact equality true for 49.94% of ALL tracked
    // tokens (6,184 of 12,383), most of which are not new/thin enough to
    // explain by coincidence alone - meaning it is far more likely a
    // genuine, common reflection of a real market condition (a thinly-
    // traded token where price simply hasn't moved between 1h-ago and
    // 5-min-ago, so the two windows legitimately compute equal) than a
    // rare data bug. Suppressing priceAccel on this signal alone would
    // have reshaped scoring for roughly half of all real candidates on
    // n=5 outcome-labeled examples - exactly the small-sample
    // overreach this sprint's own rules forbid. See the end-of-sprint
    // report, Section A/J, for the full reasoning and what additional
    // data (a genuinely independent short-interval price sample, or
    // GMGN's own documentation of how these two fields are computed)
    // would be needed to resolve this responsibly.
    let priceAccel = 0;
    if(change5m != null && change1h != null && change5m > 0 && change1h > 0){
        const pace5m = change5m * 12; // annualize the 5-minute move to an hourly pace
        if(pace5m > change1h){
            priceAccel = Math.min(1, (pace5m - change1h) / Math.max(change1h, 1));
        }
    }

    const recentWindowMin = accel.recentWindowMinutes ?? 15;
    const priorWindowMin = accel.priorWindowMinutes ?? 60;
    const nowSec = Date.now() / 1000;
    const recentCutoffSec = nowSec - recentWindowMin * 60;
    const priorCutoffSec = nowSec - priorWindowMin * 60;

    const combinedFlow = [...(smartMoneyActivity || []), ...(kolActivity || [])];
    function buyUsdInWindow(fromSec, toSec){
        return combinedFlow
            .filter(a => a.side === "buy" && a.tx_timestamp >= fromSec && a.tx_timestamp < toSec)
            .reduce((sum, a) => sum + Number(a.amount_usd || 0), 0);
    }
    const recentBuyUsd = buyUsdInWindow(recentCutoffSec, nowSec);
    const priorBuyUsd = buyUsdInWindow(priorCutoffSec, recentCutoffSec);
    const recentRatePerMin = recentBuyUsd / recentWindowMin;
    const priorRatePerMin = priorBuyUsd / Math.max(1, priorWindowMin - recentWindowMin);

    const MIN_RECENT_FLOW_USD = 25; // hygiene floor - a single dust trade shouldn't read as "infinite acceleration"
    let flowAccel = 0;
    if(recentBuyUsd >= MIN_RECENT_FLOW_USD){
        if(priorRatePerMin === 0) flowAccel = 1; // genuinely new buy pressure, nothing before it in the sampled window
        else flowAccel = Math.max(0, Math.min(1, (recentRatePerMin / priorRatePerMin - 1) / 2)); // 3x prior rate = full credit
    }

    let liquidityAccel = 0;
    const currentLiquidity = Number(token.liquidity) || null;
    const liquidityThen = tokenPriceHistoryRepository.findPriceAtOrAfter(
        token.token_address,
        new Date(Date.now() - recentWindowMin * 60000).toISOString().slice(0, 19).replace("T", " ")
    );
    if(currentLiquidity != null && liquidityThen?.liquidity > 0){
        const growth = (currentLiquidity - liquidityThen.liquidity) / liquidityThen.liquidity;
        if(growth > 0) liquidityAccel = Math.min(1, growth / 0.25); // +25% liquidity growth in the window = full credit
    }

    const compositeScore = priceAccel * 0.4 + flowAccel * 0.4 + liquidityAccel * 0.2;
    // Liquidity alone (e.g. a fresh LP add with no real buy/price action yet)
    // isn't enough to pass the entry gate - real price or flow evidence must
    // be present. Liquidity still counts toward the scored bonus above.
    const gatePassed = priceAccel > 0 || flowAccel > 0.3;

    // Observability only (Production Stabilization Final, Section A) -
    // never read by gatePassed/priceAccel/any decision above. Exposed so
    // a future sprint, once enough outcome-labeled real data exists, can
    // actually test whether this correlates with bad outcomes instead of
    // guessing from n=5 the way this sprint deliberately declined to.
    const isDuplicateWindow = change5m != null && change1h != null && change5m === change1h;

    return { priceAccel, flowAccel, liquidityAccel, compositeScore, gatePassed, isDuplicateWindow };

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
        // Decision Engine V2 diagnosis sprint (2026-08-01): real production
        // runtime data (5 consecutive live cycles, ~200-225 scanned tokens
        // each) showed only ~1 candidate per cycle ever reached scoringConfig.js's
        // default actionTiers.buy=62 - the rest landed in HOLD (109-124/cycle)
        // or AVOID (88-100/cycle), confirmed via entryGateService's own
        // skipReasons breakdown (NOT_A_BUY_TIER_HOLD/NOT_A_BUY_TIER_AVOID),
        // not inferred from code alone. scoringConfig.js's own comment on
        // actionTiers already flags 62/80 as "a deliberate policy tightening,
        // not a new data-validated number... should be re-checked against
        // fresh recommendation_outcomes data once enough volume accumulates" -
        // this is that re-check, scoped to Momentum Hunter ONLY (a local
        // override here, never scoringConfig.js's own global default, which
        // every other philosophy/version still uses unchanged).
        //
        // 58 chosen deliberately conservative, NOT the already-defined
        // "aggressive" philosophy's tournament-tested-but-unproven-as-winner
        // buy=52 a few entries above - a small, reversible step down from 62
        // first, to be measured via paper trading before considering any
        // further move toward 52. strongBuy (80) and hold (35) are
        // deliberately left untouched - only the BUY floor moves.
        weights: {}, tiers: { buy: 58 }, minLiquidityUsd: null, flattenEarliness: true, smBonus: false
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

    // Early Momentum Hunter refactor: absent for every profile except
    // Aggressive today (philosophy.acceleration undefined -> accelSignal
    // null -> accelerationBonus 0 -> byte-identical to pre-refactor math).
    const accelSignal = computeAccelerationSignal(token, trenchesEntry, smartMoneyActivity, kolActivity, philosophy.acceleration);
    const accelerationBonus = accelSignal ? Math.round(PARTICIPANT_MAX * (philosophy.acceleration.maxBonusFraction ?? 0) * accelSignal.compositeScore) : 0;

    const participantScore = Math.max(0, Math.min(PARTICIPANT_MAX, Math.round(participantScoreRaw - penalty) + accelerationBonus));

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
    // Profile-tunable volume floor - no philosophy sets this today (undefined/null),
    // so this branch is a strict no-op unless a Strategy Profile opts in.
    else if(philosophy.minVolumeUsd != null && Number(token.volume_1h ?? 0) < philosophy.minVolumeUsd){ action = "AVOID"; vetoed = true; }

    const allModules = [...Object.values(participantModules), ...Object.values(marketModules)];
    const freshnessPenalty = computeFreshnessPenalty(marketAgeSeconds);
    // False Positive Reduction V2, Priority 3: risk must be known BEFORE
    // confidence is computed, not after - see computeConfidence's own
    // header comment for why.
    const hardTriggers = [vetoed, change1h != null && change1h >= 500];
    const risk = computeRisk(riskReasons, hardTriggers);
    const confidenceResult = computeConfidence(participantScore, marketScore, allModules, freshnessPenalty, risk);
    const confidence = confidenceResult.value;

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

    // Early Momentum Hunter refactor: "enters BEFORE confirmation" as a
    // real requirement, not a lower bar on the same static evidence -
    // a BUY/STRONG BUY tier alone is not sufficient when the philosophy
    // requires it; real acceleration evidence (price pace or flow pace,
    // see computeAccelerationSignal) must also be present, or this cycle
    // is declined (downgraded to HOLD) the same way philosophy.entryGate
    // declines one above. Absent for every profile except Aggressive.
    if(philosophy.acceleration?.requireGateForEntry && (action === "BUY" || action === "STRONG BUY")){
        if(!accelSignal?.gatePassed) action = "HOLD";
    }

    // False Positive Reduction V2, Priority 5 (observability): the
    // explicit, named list of "evidence yang tidak tersedia" - every
    // module that reported hasData:false for THIS token, in plain
    // language. Previously derivable only by a reader manually scanning
    // `breakdown` for hasData:false entries; now a first-class field.
    const missingEvidence = Object.entries({ ...participantModules, ...marketModules })
        .filter(([, m]) => !m.hasData)
        .map(([key]) => MODULE_LABELS[key] || key);

    return {
        action, participantScore, participantMax: PARTICIPANT_MAX, marketHealth: marketScore, marketHealthMax: MARKET_MAX,
        confidence, risk, reasons: reasons.length ? reasons : ["No strong participant signal detected yet"],
        // Live Decision Center / Signal Center sprint: both already computed
        // above (line ~545/566) to feed `risk`/`confidence` themselves, then
        // discarded - same "computed then discarded" shape already fixed for
        // acceleration/breakdown. Purely additive observability fields, read
        // by no decision logic anywhere in this function.
        riskReasons, freshnessPenalty, missingEvidence,
        // Priority 5: every penalty that pulled confidence down from its
        // raw blended value, named individually - see computeConfidence's
        // own header comment.
        confidenceBreakdown: confidenceResult,
        breakdown: {
            participant: Object.fromEntries(Object.entries(participantModules).map(([k,m]) => [k, { score:m.score, max:m.max, hasData:m.hasData }])),
            market: Object.fromEntries(Object.entries(marketModules).map(([k,m]) => [k, { score:m.score, max:m.max, hasData:m.hasData }]))
        },
        // null for every profile except Aggressive today - see
        // computeAccelerationSignal. Exposed for observability (benchmark
        // reports, admin panel) - never consumed elsewhere in this function.
        acceleration: accelSignal ? { ...accelSignal, bonusApplied: accelerationBonus } : null,
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

// Profile-aware entry point (Strategy Profile refactor): dynamically
// merges a caller-supplied override onto a NAMED base philosophy from
// PHILOSOPHIES, without editing that static array or forking
// analyzeTokenWithPhilosophy. `override` is optional/partial - any
// field it omits falls back to the base philosophy's own value, so
// `override` undefined/null reproduces the base philosophy exactly.
function analyzeTokensWithOverride(tokens, ctx, baseKey, override){
    const base = PHILOSOPHIES.find(p => p.key === baseKey);
    if(!base) throw new Error(`analyzeTokensWithOverride: unknown base philosophy key '${baseKey}'`);
    const philosophy = !override ? base : {
        ...base,
        ...override,
        weights: { ...(base.weights || {}), ...(override.weights || {}) },
        tiers: { ...(base.tiers || {}), ...(override.tiers || {}) }
    };
    return tokens.map(token => analyzeTokenWithPhilosophy(token, ctx, philosophy));
}

module.exports = { buildEngines, preloadContext, PHILOSOPHIES, analyzeTokensWithOverride };
