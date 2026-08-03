// services/realtimePulseService.js - Arjuna V4 Phase 2. THE Realtime
// Pulse computation layer: turns a token's rolling 3-point poll history
// (services/realtimePulseBufferService.js) into named, explainable
// signals - velocity, acceleration, direction, consistency - using ONLY
// real elapsed time between real polls, never an assumed fixed interval
// (see config/realtimePulseConfig.js and PHASE2_ARCHITECTURE_REVIEW.md
// Section 1's "fixed-interval-assumed" finding).
//
// FORMULA POLICY (explicit, per the sprint brief): everything in this
// file is INFRASTRUCTURE MATH, not trading decision math. "Velocity" here
// means the standard, unambiguous rate-of-change definition
// (delta / real-elapsed-seconds) - there is exactly one correct way to
// compute a rate of change, it is not a strategic choice. "Direction" is
// a plain sign check (positive/negative/exactly-zero) - no invented
// epsilon/threshold band. "Consistency" is a structural sign-agreement
// check across the two available transitions in the 3-point buffer - not
// a weighted score. None of this file decides whether a signal is "good"
// or "bad", how much it should matter, or changes any BUY/SELL/HOLD
// decision - see researchEngineFactory.js/dynamicExitService.js for the
// explicitly marked, currently-inert integration points where the
// Solution Architect's real formula will eventually plug in.
//
// The two CROSS-SIGNAL composite fields this file also computes
// (flowDirectionVoteProvisional / consistencyVoteProvisional) are a
// simple majority-count over the per-signal directions above, clearly
// named *Provisional* and used for logging/observability/dashboard
// display ONLY - never read by any scoring or gating code path. See this
// file's own header and the implementation report for why a real
// cross-signal combination rule is deliberately left to the Architect.

const realtimePulseBufferService = require("./realtimePulseBufferService");
const realtimePulseRepository = require("../repositories/realtimePulseRepository");
const realtimePulseConfig = require("../config/realtimePulseConfig");

// The real fields tracked per poll, and how each derived series is read
// off a raw point. `derive` fields (netFlow5m, buyPressure,
// smartMoneyNetUsd, kolNetUsd) are plain arithmetic differences/ratios of
// two already-real numbers on the SAME point - not a second data source,
// not a trading formula.
const TRACKED_SIGNALS = {
    price: p => numOrNull(p.price),
    liquidity: p => numOrNull(p.liquidity),
    holders: p => numOrNull(p.holders),
    volume1h: p => numOrNull(p.volume1h),
    buys5m: p => numOrNull(p.buys5m),
    sells5m: p => numOrNull(p.sells5m),
    netFlow5m: p => (numOrNull(p.buys5m) != null && numOrNull(p.sells5m) != null) ? (p.buys5m - p.sells5m) : null,
    buyPressure: p => {
        const buys = numOrNull(p.buys5m), sells = numOrNull(p.sells5m);
        if(buys == null || sells == null || (buys + sells) === 0) return null;
        return buys / (buys + sells);
    },
    smartMoneyNetUsd: p => (numOrNull(p.smartMoneyBuyUsd) != null && numOrNull(p.smartMoneySellUsd) != null) ? (p.smartMoneyBuyUsd - p.smartMoneySellUsd) : null,
    kolNetUsd: p => (numOrNull(p.kolBuyUsd) != null && numOrNull(p.kolSellUsd) != null) ? (p.kolBuyUsd - p.kolSellUsd) : null
};

function numOrNull(v){
    if(v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// Real rate of change between two points for one derived series - the
// ONLY math primitive every velocity/acceleration signal is built from.
// Divides by REAL elapsed seconds between the two points' own real
// timestamps - never an assumed 30s. Fails to null (never fabricated) on
// missing data, non-positive/zero elapsed time (clock issue, duplicate
// timestamp, or out-of-order points), or a non-finite result.
function velocityBetween(pointA, pointB, reader){

    const a = reader(pointA);
    const b = reader(pointB);

    if(a == null || b == null) return null;

    const elapsedSeconds = (pointB.recordedAtMs - pointA.recordedAtMs) / 1000;
    if(!(elapsedSeconds > 0)) return null;

    const velocity = (b - a) / elapsedSeconds;
    return Number.isFinite(velocity) ? velocity : null;

}

// Plain sign classification - "UP" (b > a), "DOWN" (b < a), "FLAT"
// (exactly equal), null (insufficient data). No invented epsilon band -
// per PHASE2_ARCHITECTURE_REVIEW.md Section 2's explicit recommendation
// against fuzzy thresholds this file isn't authorized to choose.
function directionOf(velocity){
    if(velocity == null) return null;
    if(velocity > 0) return "UP";
    if(velocity < 0) return "DOWN";
    return "FLAT";
}

// One tracked series' full signal set for a given buffer (oldest-first,
// up to BUFFER_SIZE real points). Never assumes 3 points are present -
// every field below degrades gracefully (fails open to null) as buffer
// length drops from 3 to 2 to 0/1, exactly mirroring every other module
// in this codebase's "hasData:false, never guessed" convention.
function computeSeriesSignal(buffer, reader){

    const n = buffer.length;

    if(n < 2){
        return {
            velocity: null, direction: null, acceleration: null, consistency: null,
            intervalSecondsUsed: null, stale: null
        };
    }

    const last = buffer[n - 1];
    const prev = buffer[n - 2];

    const velocity = velocityBetween(prev, last, reader);
    const direction = directionOf(velocity);
    const intervalSecondsUsed = (last.recordedAtMs - prev.recordedAtMs) / 1000;

    let acceleration = null;
    let consistency = null;

    if(n >= 3){

        const prevPrev = buffer[n - 3];
        const earlierVelocity = velocityBetween(prevPrev, prev, reader);

        if(earlierVelocity != null && velocity != null && intervalSecondsUsed > 0){
            // How much the rate itself changed, per second, over the most
            // recent interval - the standard finite-difference definition
            // of acceleration (a second derivative), not a trading-specific
            // formula. Positive = genuinely speeding up in the current
            // direction; negative = losing steam (this file deliberately
            // does not expose separate "Acceleration"/"Deceleration"
            // fields for the same number's two signs - see this file's
            // own implementation-report note).
            const raw = (velocity - earlierVelocity) / intervalSecondsUsed;
            acceleration = Number.isFinite(raw) ? raw : null;
        }

        const earlierDirection = directionOf(earlierVelocity);
        if(earlierDirection != null && direction != null){
            consistency = earlierDirection === direction ? `CONSISTENT_${direction}` : "MIXED";
        }

    }

    return { velocity, direction, acceleration, consistency, intervalSecondsUsed, stale: null };

}

// Every tracked series' signal set, computed fresh from whatever the
// buffer holds right now - deliberately NOT cached separately from the
// buffer itself, so there is exactly one source of truth and no risk of
// a stale computed copy drifting from the real buffer state. Cheap by
// construction: at most a handful of arithmetic operations per series
// over at most 3 points (see PHASE2_ARCHITECTURE_REVIEW.md Section 7's
// performance estimate).
// nominalIntervalMs defaults to 30000 - gmgnTrendingScheduler.js's own
// real INTERVAL_MS, duplicated here as a documented fallback ONLY so
// consumers outside the scheduler layer (researchEngineFactory.js,
// dynamicExitService.js) don't need a service->scheduler require just for
// one constant. The scheduler itself always passes its own live
// INTERVAL_MS explicitly (see triggerRealtimePulseTick) - this default is
// never the real source of truth, only a documented mirror of it.
function computeTokenSignals(tokenAddress, nominalIntervalMs = 30000){

    const buffer = realtimePulseBufferService.getBuffer(tokenAddress);

    const perSignal = {};
    for(const [name, reader] of Object.entries(TRACKED_SIGNALS)){
        perSignal[name] = computeSeriesSignal(buffer, reader);
    }

    // Staleness flag per PHASE2_ARCHITECTURE_REVIEW.md Section 1/8 -
    // real elapsed time already makes every velocity/acceleration number
    // above mathematically honest even across an abnormally large gap
    // (it's a genuinely lower-frequency reading, not a wrong one), but an
    // abnormally large gap is still worth surfacing for observability so
    // a consumer can tell "confident recent trend" from "coarse trend
    // over a degraded collector window" apart. Reuses
    // STALE_POINT_INTERVAL_MULTIPLIER (3x, already an established
    // convention elsewhere in this codebase - see the config file's own
    // comment) rather than inventing a new bound.
    const staleBoundSeconds = (nominalIntervalMs / 1000) * realtimePulseConfig.STALE_POINT_INTERVAL_MULTIPLIER;
    for(const signal of Object.values(perSignal)){
        if(signal.intervalSecondsUsed != null){
            signal.stale = signal.intervalSecondsUsed > staleBoundSeconds;
        }
    }

    // Cross-signal composites - PROVISIONAL, observability-only, majority-
    // count summaries. Never read by researchEngineFactory.js's scoring
    // or entryGateService.js's gates - see this file's own header.
    const directions = Object.values(perSignal).map(s => s.direction).filter(Boolean);
    const upCount = directions.filter(d => d === "UP").length;
    const downCount = directions.filter(d => d === "DOWN").length;
    const flowDirectionVoteProvisional = directions.length === 0 ? null
        : upCount > downCount ? "UP"
        : downCount > upCount ? "DOWN"
        : "MIXED";

    const consistencies = Object.values(perSignal).map(s => s.consistency).filter(Boolean);
    const consistentCount = consistencies.filter(c => c.startsWith("CONSISTENT_")).length;
    const consistencyVoteProvisional = consistencies.length === 0 ? null
        : consistentCount >= (consistencies.length - consistentCount) ? "MOSTLY_CONSISTENT" : "MOSTLY_MIXED";

    return {
        tokenAddress,
        bufferLength: buffer.length,
        signals: perSignal,
        flowDirectionVoteProvisional,
        consistencyVoteProvisional,
        computedAtMs: Date.now()
    };

}

// Builds one real raw point for a token from already-fetched data - never
// a new fetch, never a new GMGN call (see PHASE2_ARCHITECTURE_REVIEW.md
// Section 7's "zero new network calls" performance requirement). `token`
// is a gmgn_tokens row, `trenchesEntry` a gmgn_trenches row (nullable),
// `smartMoneyAgg`/`kolAgg` are { buyUsd, sellUsd, tradeCount } already
// aggregated once per tick (see runPulseTick below) - never a per-token
// query.
function buildRawPoint(token, trenchesEntry, smartMoneyAgg, kolAgg){
    return {
        recordedAtMs: Date.now(),
        price: numOrNull(token.price),
        liquidity: numOrNull(token.liquidity),
        holders: numOrNull(token.holders),
        volume1h: numOrNull(token.volume_1h),
        buys5m: numOrNull(token.buys_5m),
        sells5m: numOrNull(token.sells_5m),
        priceChange5m: numOrNull(token.price_change_5m),
        priceChange1h: numOrNull(token.price_change_1h),
        netBuy24h: numOrNull(trenchesEntry?.net_buy_24h),
        smartMoneyBuyUsd: numOrNull(smartMoneyAgg?.buyUsd) ?? 0,
        smartMoneySellUsd: numOrNull(smartMoneyAgg?.sellUsd) ?? 0,
        smartMoneyTradeCount: smartMoneyAgg?.tradeCount ?? 0,
        kolBuyUsd: numOrNull(kolAgg?.buyUsd) ?? 0,
        kolSellUsd: numOrNull(kolAgg?.sellUsd) ?? 0,
        kolTradeCount: kolAgg?.tradeCount ?? 0
    };
}

function pointToRepositoryRow(tokenAddress, point){
    return {
        tokenAddress,
        price: point.price, liquidity: point.liquidity, holders: point.holders, volume1h: point.volume1h,
        buys5m: point.buys5m, sells5m: point.sells5m,
        priceChange5m: point.priceChange5m, priceChange1h: point.priceChange1h, netBuy24h: point.netBuy24h,
        smartMoneyBuyUsd: point.smartMoneyBuyUsd, smartMoneySellUsd: point.smartMoneySellUsd, smartMoneyTradeCount: point.smartMoneyTradeCount,
        kolBuyUsd: point.kolBuyUsd, kolSellUsd: point.kolSellUsd, kolTradeCount: point.kolTradeCount
    };
}

// Groups a feed-type's rows by token_address once, then sums buy/sell USD
// per token - the SAME real gmgn_activity_feed data and the SAME
// aggregation shape smartMoney.js/kol.js's own callers already build
// (researchEngineFactory.js's groupByToken), computed once per Pulse tick
// here rather than re-read per candidate.
function aggregateActivityByToken(rows){
    const map = new Map();
    for(const row of rows){
        const address = row.token_address;
        if(!address) continue;
        const entry = map.get(address) || { buyUsd: 0, sellUsd: 0, tradeCount: 0 };
        const amount = Number(row.amount_usd) || 0;
        if(row.side === "buy") entry.buyUsd += amount;
        else if(row.side === "sell") entry.sellUsd += amount;
        entry.tradeCount += 1;
        map.set(address, entry);
    }
    return map;
}

// Restores a token's in-memory buffer from its durable history - called
// once per token the first time this process sees it (never re-seeds an
// already-buffered token, see realtimePulseBufferService.seedBuffer's own
// idempotency). Removes the ~90s post-restart cold-start window the
// original architecture review flagged as an open improvement.
function warmStartFromDurableHistory(tokenAddress){
    const rows = realtimePulseRepository.findRecentForToken(tokenAddress, realtimePulseConfig.BUFFER_SIZE);
    if(!rows.length) return;
    const points = rows.map(row => ({
        recordedAtMs: Date.parse(`${String(row.recorded_at).replace(" ", "T")}Z`),
        price: row.price, liquidity: row.liquidity, holders: row.holders, volume1h: row.volume_1h,
        buys5m: row.buys_5m, sells5m: row.sells_5m,
        priceChange5m: row.price_change_5m, priceChange1h: row.price_change_1h, netBuy24h: row.net_buy_24h,
        smartMoneyBuyUsd: row.smart_money_buy_usd, smartMoneySellUsd: row.smart_money_sell_usd, smartMoneyTradeCount: row.smart_money_trade_count,
        kolBuyUsd: row.kol_buy_usd, kolSellUsd: row.kol_sell_usd, kolTradeCount: row.kol_trade_count
    }));
    realtimePulseBufferService.seedBuffer(tokenAddress, points);
}

// THE per-tick orchestration entry point - called once per
// gmgnTrendingScheduler collector tick (see that file's own wiring),
// never independently scheduled (avoids the "duplicate polling" risk
// PHASE2_ARCHITECTURE_REVIEW.md Section 8 identified from two
// independently-drifting timers). Scoped strictly to the fresh-universe
// population already computed for scoring - never the full gmgn_tokens
// table - and does a single batched DB write, matching
// tokenPriceHistoryRepository's own proven insert pattern.
//
// tokens: fresh-universe token rows (freshUniverseService.getBuyCandidateUniverse().tokens).
// trenchesByAddress/smartMoneyRows/kolRows: already-fetched this tick by
// the caller - this function makes no new query of its own beyond one
// batched insert.
function runPulseTick({ tokens, trenchesByAddress, smartMoneyRows, kolRows, nominalIntervalMs }){

    const startedAt = Date.now();

    const smartMoneyByToken = aggregateActivityByToken(smartMoneyRows || []);
    const kolByToken = aggregateActivityByToken(kolRows || []);

    const activeAddresses = new Set();
    const repositoryRows = [];
    const computedByToken = new Map();

    for(const token of tokens){

        const address = token.token_address;
        if(!address) continue;

        activeAddresses.add(address);

        // First time this process has seen this token - try to warm-start
        // from durable history before recording today's new point, so a
        // token already tracked before a restart doesn't start fully cold.
        if(!realtimePulseBufferService.getBuffer(address).length){
            warmStartFromDurableHistory(address);
        }

        const trenchesEntry = trenchesByAddress?.get(address) ?? null;
        const point = buildRawPoint(token, trenchesEntry, smartMoneyByToken.get(address), kolByToken.get(address));

        realtimePulseBufferService.recordPoint(address, point);
        repositoryRows.push(pointToRepositoryRow(address, point));

        computedByToken.set(address, computeTokenSignals(address, nominalIntervalMs));

    }

    // Explicit eviction (the fix for the original design's vague "ages
    // out" language) - a token that fell out of the fresh universe this
    // tick is removed outright, not left to accumulate.
    const evicted = realtimePulseBufferService.evictExcept(activeAddresses);

    // Single batched write, same transaction-per-batch pattern
    // tokenPriceHistoryRepository.insertMany already uses.
    realtimePulseRepository.insertMany(repositoryRows);

    const durationMs = Date.now() - startedAt;

    return {
        tokenCount: tokens.length,
        evictedCount: evicted,
        durationMs,
        computedByToken
    };

}

// Read-only accessor for consumers (researchEngineFactory.js,
// dynamicExitService.js, dashboard/observability) - recomputes fresh from
// whatever the buffer currently holds, same function runPulseTick already
// used, so a mid-cycle read is always consistent with the last tick's
// own computation.
function getLatestSignals(tokenAddress, nominalIntervalMs = 30000){
    return computeTokenSignals(tokenAddress, nominalIntervalMs);
}

module.exports = {
    TRACKED_SIGNALS,
    velocityBetween,
    directionOf,
    computeSeriesSignal,
    computeTokenSignals,
    buildRawPoint,
    aggregateActivityByToken,
    warmStartFromDurableHistory,
    runPulseTick,
    getLatestSignals
};
