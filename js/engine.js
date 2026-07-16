// =====================================
// CRAB AGENT ENGINE V11
// COIN QUALITY + BUY TIMING + CONFIDENCE
//
// V11 note: this update only changes the LABELING layer
// (action/signal naming, all comments and reason/risk
// strings translated to English) and standardizes the
// signal vocabulary to exactly 4 values: STRONG BUY, BUY,
// HOLD, AVOID. The CRAB SCORE mathematical formula itself
// (every weight, threshold, and penalty below) is
// unchanged from V10 - nothing about how the number is
// calculated was touched, only what the resulting number
// is called.
//
// 1) COIN QUALITY - "is this coin worth watching?"
//    liquidityScore, fdvScore, backingScore, holderScore
//    (holder stays null - there is no free holder-count
//    data source; shown honestly as "-", never penalized
//    or credited with a made-up value)
//
// 2) BUY TIMING - "is NOW the right moment?"
//    momentumScore, ratioScore, tradesScore, buySellScore
//    - uses priceChange.m5/h1/h6/h24 (real DexScreener
//    fields), txns.m5/h1/h24 buy-sell split per timeframe,
//    volume h1 vs the h24 hourly average, and pairCreatedAt
//    (real field) for early-gem detection.
//
// 3) CONFIDENCE - calculated from data completeness (how
//    many timeframes are actually available) AND direction
//    agreement across timeframes (m5/h1/h6/h24 pointing the
//    same way or contradicting each other), not just from
//    the raw size of the metrics.
//
// HARD BLOCKS - certain conditions force the action down
// regardless of the raw score: price actively dropping in
// the last 5 minutes, distribution (short-term buy ratio
// far weaker than the 24h ratio), fake breakout (price up
// but buy pressure weak), dead bounce (small bounce inside
// a deeper downtrend).
//
// All inputs below are real DexScreener fields
// (priceChange.{m5,h1,h6,h24}, volume.{m5,h1,h6,h24},
// txns.{m5,h1,h6,h24}.{buys,sells}, pairCreatedAt) or our
// own session history (pair.__priceHistory, filled in by
// api.js from real scan results, session-only). Nothing is
// simulated.
// =====================================

const Engine = {

    // =====================================
    // SCAN MEMORY (session-only, in-memory,
    // self-contained inside engine.js - no
    // database, no external storage).
    //
    // Mirrors the exact same pattern api.js already
    // uses for PRICE_HISTORY, but keyed for the
    // engine's own needs: last momentum reading (for
    // delta-momentum), last smoothed score
    // (exponential smoothing), and consecutive-scan
    // streak counters (multi-scan confirmation for
    // distribution/downtrend before hard-blocking).
    //
    // Bounded to avoid unbounded memory growth over a
    // long-running tab: if more than MAX_TRACKED
    // addresses accumulate, the least-recently-touched
    // entries are evicted.
    // =====================================

    _scanMemory: (function(){

        // V14 (history must survive refresh): scan memory is now
        // hydrated from sessionStorage at load, so smoothing,
        // delta-momentum and confirmation streaks continue right
        // where they left off after a page refresh instead of
        // resetting to zero. sessionStorage (not localStorage) is
        // deliberate: same tab survives refresh, but a fresh tab
        // starts clean - stale hours-old readings shouldn't leak
        // into a brand new session.

        try{

            const raw = sessionStorage.getItem("crab_engine_memory");

            if(raw) return JSON.parse(raw);

        }catch(e){}

        return {};

    })(),

    _persistMemory(){

        try{

            sessionStorage.setItem("crab_engine_memory", JSON.stringify(this._scanMemory));

        }catch(e){}

    },

    _MAX_TRACKED: 500,

    _touchMemory(address, updates){

        const now = Date.now();

        const existing = this._scanMemory[address] || {};

        this._scanMemory[address] = Object.assign({}, existing, updates, { lastSeenAt: now });

        this._persistMemory();

        const keys = Object.keys(this._scanMemory);

        if(keys.length > this._MAX_TRACKED){

            keys

                .sort((a,b)=>this._scanMemory[a].lastSeenAt - this._scanMemory[b].lastSeenAt)

                .slice(0, keys.length - this._MAX_TRACKED)

                .forEach(k=>delete this._scanMemory[k]);

        }

    },

    analyze(pair){

        // =====================================
        // CORE DATA (all real DexScreener fields)
        // =====================================

        const liquidity =
        Number(pair.liquidity?.usd || 0);

        const volumeH24 =
        Number(pair.volume?.h24 || 0);

        const volumeH1 =
        Number(pair.volume?.h1 || 0);

        const fdv =
        Number(pair.fdv || pair.marketCap || 0);

        const price =
        Number(pair.priceUsd || 0);

        // Multi-timeframe price change - m5 & h6.

        const p5 =
        Number(pair.priceChange?.m5 || 0);

        const p1 =
        Number(pair.priceChange?.h1 || 0);

        const p6 =
        Number(pair.priceChange?.h6 || 0);

        const p24 =
        Number(pair.priceChange?.h24 || 0);

        const holder =
        pair.holder != null
        ? Number(pair.holder)
        : null;

        const trades1h =
        pair.trades?.h1 != null
        ? Number(pair.trades.h1)
        : (
            pair.trades?.h24 != null
            ? Number(pair.trades.h24) / 24
            : null
        );

        const trades24h =
        pair.trades?.h24 != null
        ? Number(pair.trades.h24)
        : null;

        // Buy/Sell split per timeframe - real DexScreener
        // txns data. 24h comes from pair.trades (already
        // computed in api.js), 1h & 5m come directly from
        // pair.txns.

        const buys24h =
        pair.trades?.h24Buys != null
        ? Number(pair.trades.h24Buys)
        : null;

        const sells24h =
        pair.trades?.h24Sells != null
        ? Number(pair.trades.h24Sells)
        : null;

        const buyRatio =
        (buys24h!=null && sells24h!=null && (buys24h+sells24h)>0)
        ? buys24h/(buys24h+sells24h)
        : null;

        const buys1h = pair.txns?.h1?.buys != null ? Number(pair.txns.h1.buys) : null;
        const sells1h = pair.txns?.h1?.sells != null ? Number(pair.txns.h1.sells) : null;

        const buyRatio1h =
        (buys1h!=null && sells1h!=null && (buys1h+sells1h)>0)
        ? buys1h/(buys1h+sells1h)
        : null;

        const buys5 = pair.txns?.m5?.buys != null ? Number(pair.txns.m5.buys) : null;
        const sells5 = pair.txns?.m5?.sells != null ? Number(pair.txns.m5.sells) : null;

        const buyRatio5 =
        (buys5!=null && sells5!=null && (buys5+sells5)>0)
        ? buys5/(buys5+sells5)
        : null;

        // Age - real DexScreener field (pairCreatedAt).

        const ageHours =
        pair.pairCreatedAt
        ? (Date.now() - Number(pair.pairCreatedAt)) / 3600000
        : null;

        // Session price/liquidity history - real samples
        // taken every scan cycle by api.js, kept in memory
        // for this session only (see api.js PRICE_HISTORY).
        // Not available on the first 1-2 scans of a token.

        const history = pair.__priceHistory || null;

        // Temuan 3 fix (user testing): "EARLY" was being shown for
        // tokens that had ALREADY completed a pump-and-crash cycle
        // (age alone said "recently launched", but the chart had
        // clearly already moved and pulled back hard). Two real,
        // already-available signals catch this:
        //
        // 1) pctBelowSessionPeak - if we've been watching this
        //    token for a few scans, is the current price
        //    meaningfully below the highest price we've actually
        //    observed? (Limited to what we've personally tracked
        //    since discovery - can't see a move that happened
        //    entirely before that.)
        //
        // 2) alreadyHadBigMove - DexScreener's own 1h/6h change
        //    fields, which reflect real price history regardless
        //    of when we started watching. A huge 1h or 6h move
        //    means something big already happened recently, even
        //    on a token we just started tracking.

        const historyPeakPrice =
            history && history.length>0
            ? Math.max(...history.map(h=>h.price))
            : null;

        const pctBelowSessionPeak =
            (historyPeakPrice && price>0 && historyPeakPrice>0)
            ? ((historyPeakPrice-price)/historyPeakPrice)*100
            : null;

        // Temuan 10 fix: p24 added - the engine's own penalty
        // section already treats p24>=120 as "price already moved
        // strongly", but the EARLY/MID/LATE downgrade was only
        // checking 1h/6h windows, so a pump spread across >6h
        // could still be labeled EARLY (verified in real testing:
        // The Prophecy). Same threshold, now used consistently.

        const alreadyHadBigMove = p1>=50 || p6>=80 || p24>=120;

        const address = pair.baseToken?.address || null;

        const previousMemory = address ? this._scanMemory[address] : null;

        let score = 0;

        const reasons = [];
        const risks = [];

        // =====================================
        // VOLUME GROWTH / EXHAUSTION (real, h1 vs
        // the hourly average derived from h24)
        // =====================================

        const expectedHourlyVol = volumeH24 / 24;

        const volumeAccelerating =
            expectedHourlyVol > 0 && volumeH1 > expectedHourlyVol * 1.6;

        const volumeExhausting =
            expectedHourlyVol > 0 && volumeH1 < expectedHourlyVol * 0.35 && p24 >= 15;

        // =====================================
        // SESSION HISTORY TREND (real, coarse ~60s
        // per sample, only active once enough data
        // has accumulated)
        // =====================================

        let historyTrend = null;

        if(history && history.length >= 3){

            let higherSteps = 0;
            let lowerSteps = 0;

            for(let i=1;i<history.length;i++){

                if(history[i].price > history[i-1].price) higherSteps++;
                else if(history[i].price < history[i-1].price) lowerSteps++;

            }

            const liqStart = history[0].liquidity;
            const liqNow = history[history.length-1].liquidity;

            const liquidityTrendPercent =
                liqStart>0 ? ((liqNow-liqStart)/liqStart)*100 : 0;

            historyTrend = {

                higherSteps,

                lowerSteps,

                totalSteps: history.length-1,

                liquidityTrendPercent

            };

        }

        // =====================================
        // MOMENTUM (BUY TIMING core - m5/h1/h6/h24
        // real, weighted toward the most recent window
        // so a reversal in the last few minutes is not
        // hidden behind an older 24h pump)
        // =====================================

        const momentum =

            (p5 * 0.15) +

            (p1 * 0.35) +

            (p6 * 0.20) +

            (p24 * 0.30);

        // Delta Momentum (early detector, ROI-audit item 5):
        // how much momentum improved since the LAST time we
        // scanned this exact token - not "is momentum positive"
        // (that's the existing sweet-spot check below), but "is
        // it improving right now, even before crossing into the
        // healthy zone". This is what lets a token get an early
        // nudge one scan before its raw momentum reading alone
        // would justify it - without replacing the original
        // momentum model at all.

        const deltaMomentum =
            previousMemory?.lastMomentum != null
            ? momentum - previousMemory.lastMomentum
            : null;

        // "Decelerating": the last 5 minutes, projected
        // to an hourly rate, is already weaker than the
        // 1h window that's supposedly still positive -
        // this is the exact pattern behind a pump that
        // has quietly turned over.

        const p5HourlyRate = p5 * 12;

        const decelerating = p1 > 0 && p5HourlyRate < 0;

        let momentumScore = 0;

        // V12 change (Priority #1 - fix late BUY signals): this
        // used to be monotonic - the higher the momentum
        // reading, the higher the score, all the way up.  That
        // rewarded coins that had ALREADY pumped hard, which is
        // exactly backwards for an early-entry tool: by the time
        // blended momentum is 60%+, the move is very likely
        // already mostly done. This is now a "sweet spot" curve:
        // moderate, still-building momentum scores highest;
        // momentum that's already very high scores LOWER, not
        // higher, because that's the signature of a move that's
        // already extended rather than one that's just starting.
        //
        // V13 change (user refinement): max lowered from 30 to
        // 20 - momentum should now be a CONFIRMATION factor,
        // not the most heavily-weighted one. The freed-up weight
        // moved to Buyer Dominance (buySellScore) below. Same
        // sweet-spot shape, just proportionally smaller.

        if(momentum>=15 && momentum<45){

            momentumScore=20;
            reasons.push("Healthy, still-building momentum");

        }

        else if(momentum>=8 && momentum<15){

            momentumScore=17;
            reasons.push("Momentum starting to build");

        }

        else if(momentum>=45 && momentum<70){

            momentumScore=12;
            reasons.push("Strong momentum, approaching extended territory");

        }

        else if(momentum>=0 && momentum<8){

            momentumScore=12;
            reasons.push("Early stage - momentum just starting to turn positive");

        }

        else if(momentum>=70 && momentum<120){

            momentumScore=5;
            risks.push("Momentum already overheated - move looks late, not early");

        }

        else if(momentum>=-10 && momentum<0){

            momentumScore=2;

        }

        else if(momentum>=120){

            momentumScore=1;
            risks.push("Momentum extremely overextended - high chance this move is already over");

        }

        else{

            momentumScore=0;
            risks.push("Heavy selling pressure");

        }

        if(decelerating){

            momentumScore = Math.max(0, momentumScore-5);

            risks.push(`Momentum weakening - last 5 minutes ${p5.toFixed(1)}% while the 1h window is still ${p1.toFixed(1)}%`);

        }

        else if(p5>0 && p1>0 && (p5*12) > p1){

            momentumScore = Math.min(20, momentumScore+2);
            reasons.push("Momentum accelerating in the short term");

        }

        score+=momentumScore;

        // =====================================
        // TRADING ACTIVITY / TIMING (volume /
        // liquidity turnover + volume growth check)
        // =====================================

        const ratio =

            liquidity>0

            ? volumeH24/liquidity

            :0;

        let ratioScore=0;

        if(ratio>=6){

            ratioScore=20;
            reasons.push("Massive trading activity");

        }

        else if(ratio>=4){

            ratioScore=16;
            reasons.push("Very active trading");

        }

        else if(ratio>=2){

            ratioScore=13;

        }

        else if(ratio>=1){

            ratioScore=10;

        }

        else if(ratio>=0.5){

            ratioScore=6;

        }

        else if(ratio>=0.2){

            ratioScore=3;

        }

        else{

            ratioScore=0;
            risks.push("Weak trading activity");

        }

        if(volumeAccelerating){

            ratioScore = Math.min(20, ratioScore+2);

            const multiplier = (volumeH1/expectedHourlyVol).toFixed(1);

            reasons.push(`1h trading volume is ${multiplier}x above the daily average`);

        }

        else if(volumeExhausting){

            ratioScore = Math.max(0, ratioScore-3);

            risks.push("Trading volume is fading even though price is still elevated - possible exhaustion");

        }

        score+=ratioScore;

        // =====================================
        // LIQUIDITY (Coin Quality)
        // =====================================

        let liquidityScore=0;

        if(liquidity>=2000000){

            liquidityScore=15;
            reasons.push("Excellent liquidity");

        }

        else if(liquidity>=1000000){

            liquidityScore=13;

        }

        else if(liquidity>=500000){

            liquidityScore=10;

        }

        else if(liquidity>=100000){

            liquidityScore=7;

        }

        else if(liquidity>=30000){

            liquidityScore=4;

        }

        else if(liquidity>=10000){

            liquidityScore=2;

        }

        else{

            liquidityScore=0;
            risks.push("Low liquidity");

        }

        // Liquidity trend from session history (real, once
        // enough data has accumulated).

        if(historyTrend){

            if(historyTrend.liquidityTrendPercent <= -10){

                liquidityScore = Math.max(0, liquidityScore-4);

                risks.push(`Liquidity has dropped ${Math.abs(historyTrend.liquidityTrendPercent).toFixed(1)}% during this monitoring session`);

            }

            else if(historyTrend.liquidityTrendPercent >= 10){

                liquidityScore = Math.min(15, liquidityScore+2);

                reasons.push(`Liquidity has grown ${historyTrend.liquidityTrendPercent.toFixed(1)}% during this monitoring session`);

            }

        }

        score+=liquidityScore;

        // =====================================
        // FDV / VALUATION (Coin Quality, + early
        // gem consideration from pair age - real
        // pairCreatedAt)
        // =====================================

        let fdvScore=0;

        if(fdv<=2000000){

            fdvScore=10;
            reasons.push("Very low valuation");

        }

        else if(fdv<=5000000){

            fdvScore=8;

        }

        else if(fdv<=10000000){

            fdvScore=6;

        }

        else if(fdv<=30000000){

            fdvScore=4;

        }

        else{

            fdvScore=2;
            risks.push("High valuation");

        }

        const isEarlyGem =
            ageHours!=null && ageHours<=48 && fdv>0 && fdv<=10000000 && liquidity>=10000;

        if(isEarlyGem){

            reasons.push(`Recently launched token (${ageHours<24 ? Math.round(ageHours)+"h" : Math.round(ageHours/24)+"d"} old) with a small valuation`);

        }

        score+=fdvScore;

        // =====================================
        // LIQUIDITY BACKING (Coin Quality)
        // =====================================

        const liqPercent =

            fdv>0

            ? (liquidity/fdv)*100

            :0;

        let backingScore=0;

        if(liqPercent>=20){

            backingScore=10;
            reasons.push("Excellent liquidity backing");

        }

        else if(liqPercent>=15){

            backingScore=8;

        }

        else if(liqPercent>=10){

            backingScore=6;

        }

        else if(liqPercent>=5){

            backingScore=3;

        }

        else{

            backingScore=0;
            risks.push("Weak liquidity backing");

        }

        score+=backingScore;

        // =====================================
        // HOLDER (Coin Quality) - stays null, there
        // is no free holder-count data source. Neutral,
        // never penalized or given a made-up bonus.
        // =====================================

        let holderScore=0;

        if(holder===null){

            holderScore=4;

        }

        else if(holder>=10000){

            holderScore=8;
            reasons.push("Large, distributed holder base");

        }

        else if(holder>=5000){

            holderScore=6;

        }

        else if(holder>=2000){

            holderScore=5;

        }

        else if(holder>=500){

            holderScore=3;

        }

        else if(holder>=100){

            holderScore=1;

        }

        else{

            holderScore=0;
            risks.push("Very few holders - high concentration risk");

        }

        // ROI audit item 2: holderScore is NOT added to `score`
        // anymore. `holder` has no free data source and is
        // always null, so holderScore was always exactly the
        // same neutral constant (4) for every single token -
        // zero discriminative information, just dead weight in
        // the score budget. Its 8-point budget was moved to
        // Buyer Dominance (buySellScore) above, which is a
        // genuinely predictive, real-data component. holderScore
        // itself is still computed and returned below so the
        // existing "CRAB SCORE Breakdown" UI keeps rendering
        // exactly as before - it just no longer affects the
        // final score.

        // =====================================
        // TRADES / FREQUENCY (Buy Timing)
        // =====================================

        let tradesScore=0;

        if(trades1h===null){

            tradesScore=3;

        }

        else if(trades1h>=500){

            tradesScore=7;
            reasons.push("Very high trade frequency");

        }

        else if(trades1h>=200){

            tradesScore=5;

        }

        else if(trades1h>=50){

            tradesScore=3;

        }

        else if(trades1h>=10){

            tradesScore=1;

        }

        else{

            tradesScore=0;
            risks.push("Very low trade frequency");

        }

        score+=tradesScore;

        // =====================================
        // BUY / SELL PRESSURE ("Buyer Dominance")
        // checked across 3 timeframes (5m/1h/24h)
        // to catch distribution that just started,
        // not only the 24h snapshot.
        //
        // V13 change (user refinement): weight tripled
        // (max 5 -> 15) - this is now one of the most
        // heavily-weighted components, on par with
        // Liquidity, because consistently increasing buy
        // pressure is exactly the kind of real, early
        // signal that should count even when momentum
        // itself hasn't caught up yet.
        // =====================================

        // Weight rescaled 15 -> 23 (ROI audit item 2): the 8
        // points freed up by removing holderScore's constant,
        // uninformative contribution to `score` were moved here
        // - Buyer Dominance is a genuinely predictive, real-data
        // component, unlike holderScore which was always the
        // same neutral value for every token (no holder-count
        // data source exists). See holderScore below - it's
        // still computed and shown for display continuity, it
        // just no longer counts toward the final score.

        let buySellScore=0;

        if(buyRatio===null){

            buySellScore=9;

        }

        else if(buyRatio>=0.65){

            buySellScore=23;
            reasons.push("Buy pressure dominant");

        }

        else if(buyRatio>=0.55){

            buySellScore=18;

        }

        else if(buyRatio>=0.45){

            buySellScore=9;

        }

        else if(buyRatio>=0.35){

            buySellScore=5;

        }

        else{

            buySellScore=0;
            risks.push("Sell pressure dominant");

        }

        // Distribution just starting: 24h still looks
        // healthy but the 1h/5m window has already
        // flipped to sell-dominant.

        const recentBuyRatio =
            buyRatio5 != null ? buyRatio5 :
            buyRatio1h != null ? buyRatio1h :
            null;

        const distributionForming =
            buyRatio!=null && buyRatio>=0.5 &&
            recentBuyRatio!=null && recentBuyRatio<0.4;

        if(distributionForming){

            buySellScore = Math.max(0, buySellScore-14);

            risks.push(`Selling pressure rising - current buy ratio ${Math.round(recentBuyRatio*100)}% (24h still ${Math.round(buyRatio*100)}%)`);

        }

        // V13 addition (user refinement, Priority #2 - "buyer
        // dominance more prioritized"): the mirror-image of
        // distributionForming above. Buy pressure that is
        // CONSISTENTLY INCREASING as the window gets shorter
        // (5m > 1h > 24h baseline) means sellers are getting
        // weaker and buyers are getting stronger right now -
        // real, and worth rewarding even if price/momentum
        // hasn't moved much yet, which is exactly the kind of
        // early signal this update asks for.

        const buyerDominanceIncreasing =
            buyRatio5 != null && buyRatio1h != null &&
            buyRatio5 > buyRatio1h &&
            buyRatio1h >= (buyRatio ?? 0.4) &&
            buyRatio5 >= 0.55;

        if(buyerDominanceIncreasing && !distributionForming){

            buySellScore = Math.min(23, buySellScore + 9);

            reasons.push(`Buyer dominance building - buy ratio rising from ${Math.round((buyRatio||0)*100)}% (24h) to ${Math.round(buyRatio1h*100)}% (1h) to ${Math.round(buyRatio5*100)}% (5m)`);

        }

        score+=buySellScore;

        // =====================================
        // BONUS
        // =====================================

        let bonus=0;

        if(volumeH24>=500000)
            bonus+=2;

        if(liquidity>=1000000)
            bonus+=1;

        // Delta Momentum early nudge (ROI-audit item 5): reward
        // momentum that is CLEARLY improving scan-over-scan even
        // while it's still below the healthy zone - this is
        // exactly the "detect it before it's fully positive"
        // behaviour that was missing. Deliberately modest (+3)
        // since this is a supporting early signal, not a
        // replacement for the main momentum score.

        // V14: tiered & more sensitive - reacting the moment
        // momentum starts turning, not after it's already high.

        if(deltaMomentum != null && deltaMomentum >= 5 && momentum < 20){

            bonus += 7;
            reasons.push("Momentum turning up fast scan-over-scan - early reversal signal");

        }
        else if(deltaMomentum != null && deltaMomentum >= 2 && momentum < 15){

            bonus += 4;
            reasons.push("Momentum improving scan-over-scan, even before reaching the healthy zone");

        }

        // V12 change: this used to be `momentum>=30`, which
        // also fired for badly overextended momentum (100%,
        // 200%+) - directly undermining the sweet-spot redesign
        // above. Now only rewards momentum inside the same
        // "healthy building" zone the momentum score itself
        // rewards.

        if(momentum>=15 && momentum<45)
            bonus+=2;

        if(isEarlyGem && volumeAccelerating)
            bonus+=3;

        // =====================================
        // VOLUME QUALITY (V13 addition, user
        // refinement) - distinguishes volume made of
        // many smaller trades (more organic/healthy)
        // from volume made of a few large trades,
        // using only data already available (trade
        // COUNT + $ volume, both real) - no new API.
        // =====================================

        const avgTradeSize24h =
            trades24h != null && trades24h > 0
            ? volumeH24 / trades24h
            : null;

        const avgTradeSizeVsLiquidity =
            avgTradeSize24h != null && liquidity > 0
            ? (avgTradeSize24h / liquidity) * 100
            : null;

        const manySmallTrades =
            avgTradeSizeVsLiquidity != null && avgTradeSizeVsLiquidity < 0.5;

        const fewLargeTrades =
            avgTradeSizeVsLiquidity != null && avgTradeSizeVsLiquidity >= 1.5;

        if(manySmallTrades && trades24h >= 100){

            bonus += 2;
            reasons.push("Healthy volume - made up of many smaller trades, not a few large ones");

        }

        // "Large Buyer Activity" (V13 addition, user Priority #4
        // - honest framing): we do NOT have wallet-level data, so
        // this is NOT true whale/smart-money wallet tracking.
        // It's a proxy built only from real, already-available
        // numbers: average trade size relative to the pool,
        // combined with a strong buy-side lean. Bigger-than-usual
        // trades that are also buy-dominant is the closest real
        // signal available to "a larger buyer stepping in" without
        // adding any new data source.

        const largeBuyerActivity =
            fewLargeTrades &&
            buyRatio != null && buyRatio >= 0.6;

        if(largeBuyerActivity){

            bonus += 4;
            reasons.push("Larger-than-average trades leaning strongly toward buying");

        }

        // =====================================
        // EARLY ACCUMULATION (V12, made significantly
        // more aggressive in V13 per user request - this
        // is now the highest-priority bonus in the engine).
        // Tiered instead of a single flat bonus: the more
        // of the real "textbook accumulation" traits are
        // present at once (rising volume, buyers building,
        // price still flat, no big candle yet, no
        // distribution), the bigger the reward - using only
        // data already computed above.
        // =====================================

        const noBigCandleYet = p1 < 10 && p5 < 5;

        const veryFlatPrice = p24 >= -5 && p24 <= 10;

        const flatPrice = p24 >= -5 && p24 <= 15;

        let accumulationTier = null;

        if(

            volumeAccelerating &&
            buyRatio != null && buyRatio >= 0.55 &&
            veryFlatPrice &&
            noBigCandleYet &&
            !distributionForming

        ){

            accumulationTier = "strong";
            bonus += 18;
            reasons.push("Strong accumulation - volume and buyers both rising while price is still flat, no big candle yet");

        }

        else if(

            volumeAccelerating &&
            (buyRatio == null || buyRatio >= 0.5) &&
            flatPrice &&
            !distributionForming

        ){

            accumulationTier = "moderate";
            bonus += 12;
            reasons.push("Early accumulation - volume rising while price is still flat");

        }

        else if(

            (volumeAccelerating || buyerDominanceIncreasing) &&
            p24 >= -8 && p24 <= 18 &&
            !distributionForming

        ){

            accumulationTier = "early";
            bonus += 6;
            reasons.push("Early signs of accumulation building");

        }

        const isAccumulating = accumulationTier !== null;

        // Breakout Probability (Temuan 1 fix, user testing): this
        // used to be computed ONLY in ui.js purely for display in
        // the Confidence Breakdown - the action tier (BUY/STRONG
        // BUY/etc) never actually saw it, so a token could show
        // "Breakout Probability 34/100" while still carrying a
        // STRONG BUY badge. Moving the same formula here means it
        // can now genuinely cap the action below (see hard-block
        // section), and ui.js reads this returned value instead
        // of recomputing it (removes duplicated logic too).

        const breakoutProbability = Math.min(100, Math.round(

            (volumeAccelerating ? 40 : 10) +

            (isAccumulating ? 30 : 0) +

            ((buySellScore/23) * 30)

        ));

        if(historyTrend && historyTrend.higherSteps > historyTrend.lowerSteps && historyTrend.totalSteps>=2){

            bonus+=2;

            reasons.push("Price has trended upward across the last few scans this session");

        }

        score+=bonus;

        // =====================================
        // PENALTY + HARD BLOCKS
        // The conditions below must NEVER produce a
        // STRONG BUY / BUY, regardless of the raw
        // score - this is what prevents a "high score
        // but the chart is actually dropping" outcome.
        // =====================================

        let penalty = 0;

        let hardBlockBuy = false;
        let hardBlockStrongBuy = false;

        // Temuan 1 fix (user testing): Breakout Probability and
        // Market Structure (backing) were previously shown in the
        // Confidence Breakdown purely for information - a token
        // could display "Breakout Probability 34/100" and
        // "Market Structure 30/100" while still carrying a STRONG
        // BUY badge, which is a real contradiction users caught.
        // Both now genuinely cap STRONG BUY down to BUY when
        // they're weak - they don't block BUY entirely, since a
        // low breakout probability or thin structural backing
        // isn't the same severity as active selling/overextension,
        // it just means the highest-confidence tier isn't earned.

        if(breakoutProbability < 40){

            hardBlockStrongBuy = true;
            risks.push("Breakout probability is low - continuation isn't well supported yet");

        }

        // Temuan 9 (real-testing evidence: every SL hit in live
        // testing was a thin-liquidity token): RATIO-based backing
        // can look perfect while the pool is tiny in absolute
        // dollars - $15K of liquidity moves violently on a single
        // moderate sell no matter how healthy the ratio is.
        // Calibrated against the actual test set so it blocks the
        // sub-$10K deathtraps without killing thin-but-real
        // winners (Yuki hit TP at ~$15K liquidity - stays BUY).

        if(liquidity < 10000){

            hardBlockBuy = true;
            penalty += 5;
            risks.push("Liquidity is extremely thin (under $10K) - a single sell can crash the price");

        }
        else if(liquidity < 20000){

            hardBlockStrongBuy = true;
            penalty += 2;
            risks.push("Liquidity is very thin in absolute terms - expect violent price swings");

        }

        if(backingScore <= 3){

            hardBlockStrongBuy = true;
            risks.push("Liquidity backing is thin relative to valuation");

            // Temuan 2 fix (user testing): weak backing used to
            // only cap the action label (Temuan 1 fix above) - it
            // never touched `penalty`, which means it never
            // lowered Confidence either (confidence = ... -
            // penalty + ...). Thin structural backing is a real
            // risk, not just a reason to withhold the top label -
            // it should measurably reduce how much the engine
            // trusts the signal too.

            penalty += (backingScore === 0) ? 6 : 4;

        }

        // Price is actively dropping SHARPLY right now
        // (last 5 minutes) - the most direct signal, and
        // the one most often missed by a snapshot-only
        // engine.

        if(p5 <= -4){

            penalty += 10;
            hardBlockBuy = true;
            risks.push(`Price dropped ${p5.toFixed(1)}% in the last 5 minutes`);

        }

        // Soft hard-block (ROI audit item 1): -1.5% in 5 minutes
        // is a completely normal wiggle, not a real danger signal
        // - it was blocking STRONG BUY outright before. Now only
        // a genuinely sharp -2.5%+ drop triggers the hard block;
        // anything milder gets a proportional soft penalty
        // instead, scaled to how negative it actually is.

        else if(p5 <= -2.5){

            penalty += 6;
            hardBlockStrongBuy = true;

        }

        else if(p5 <= -1.5){

            penalty += Math.round(Math.abs(p5));

        }

        // Soft hard-block (ROI audit item 1): ANY negative
        // momentum (even -0.01%) used to hard-block STRONG BUY
        // outright - far too sensitive, a routine source of
        // noisy late/flickering signals. Only meaningfully
        // negative momentum (<-5) still hard-blocks; mild
        // negative momentum gets a small proportional penalty
        // instead, preserving protection without over-blocking.

        if(momentum < -5){

            hardBlockStrongBuy = true;
            penalty += 3;

        }
        else if(momentum < 0){

            penalty += Math.round(Math.abs(momentum) * 0.5);

        }

        // Multi-scan confirmation streaks (ROI audit item 4).
        // Computed once here, used below to decide whether
        // distribution/downtrend get a soft penalty (first time
        // seen) or the full hard-block (confirmed 2 scans in a
        // row) - reduces noisy single-scan false positives
        // without slowing down genuinely fast, healthy signals
        // (those paths are untouched).

        // V14: positive confirmation streak - consecutive scans
        // where this token already qualified as BUY-tier. Used
        // BELOW to RAISE confidence (persistence = more trust),
        // never to gate/delay the entry itself.

        const priorBuyStreak = previousMemory?.buyStreak || 0;

        const priorDistributionStreak = previousMemory?.distributionStreak || 0;
        const distributionStreak = distributionForming ? priorDistributionStreak + 1 : 0;

        const currentlyDowntrend =
            historyTrend && historyTrend.totalSteps>=2 && historyTrend.lowerSteps > historyTrend.higherSteps;

        const priorDowntrendStreak = previousMemory?.downtrendStreak || 0;
        const downtrendStreak = currentlyDowntrend ? priorDowntrendStreak + 1 : 0;

        // Repeated downward pattern in our own session
        // history (real, not just a snapshot).

        if(currentlyDowntrend){

            if(downtrendStreak >= 2){

                penalty += 5;
                hardBlockStrongBuy = true;
                risks.push("A downward price pattern was detected during this monitoring session");

            }
            else{

                penalty += 2;

            }

        }

        // Distribution just starting - never give a
        // STRONG BUY while the token is being sold into.

        if(distributionForming){

            if(distributionStreak >= 2){

                penalty += 5;
                hardBlockStrongBuy = true;

            }
            else{

                penalty += 2;

            }

        }

        // Large volume while price falls = active
        // distribution.

        if(p24 < -5 && ratio>=2){

            penalty += 6;
            hardBlockBuy = true;
            risks.push("Large volume while price is falling - sign of active distribution");

        }

        // V12 change (Priority #1): these thresholds used to
        // start at 120%/250%/500% - meaning a coin that had
        // already pumped 80-100% in 24h got ZERO overextension
        // penalty. That's a big part of why BUY signals kept
        // showing up on coins that were already falling by the
        // time someone opened DexScreener. Thresholds are now
        // roughly half of what they were.

        if(p24 >= 200){

            penalty += 15;
            risks.push("Already pumped significantly");
            hardBlockStrongBuy = true;

            // V13 (user refinement - more conservative on late
            // signals): this used to only block STRONG BUY,
            // capping down to BUY. Since Buyer Dominance now
            // carries much more weight, a coin that already
            // pumped 200%+ could still reach BUY on strong buy-
            // side order flow alone (which can just as easily be
            // late FOMO chasing as it can be genuine strength).
            // At this level of extension, cap at HOLD - never BUY.

            hardBlockBuy = true;

        }

        else if(p24 >= 100){

            penalty += 8;
            risks.push("Very extended price move");
            hardBlockStrongBuy = true;

        }

        else if(p24 >= 50){

            penalty += 3;
            risks.push("Price already moved strongly");

        }

        // Fake breakout: price up sharply but short-term
        // buy pressure is weak - the breakout isn't backed
        // by real buyers.

        if(p24>=40 && buyRatio5!=null && buyRatio5<0.4){

            penalty += 8;
            hardBlockStrongBuy = true;
            hardBlockBuy = true;
            risks.push("Possible fake breakout - price up but buy pressure is weak");

        }

        // Dead bounce: a small bounce inside a still-deep
        // downtrend (h1 & h24 both deeply negative, m5 just
        // turned slightly positive).

        if(p5>0 && p1<=-8 && p24<=-8){

            penalty += 8;
            hardBlockStrongBuy = true;
            hardBlockBuy = true;
            risks.push("Dead bounce - a small bounce inside a deeper downtrend");

        }

        if(volumeExhausting){

            penalty += 3;

        }

        if(ratio >= 25){

            // V14 penalty audit: extreme turnover is how newborn
            // winners LOOK (verified in real testing - tokens that
            // hit TP had 20x+ turnover too). Softened 5 -> 2; real
            // protection comes from exhaustion/distribution checks.

            penalty += 2;
            risks.push("Extremely volatile trading");

        }

        else if(ratio >= 15){

            penalty += 2;
            risks.push("Very high speculation");

        }

        score -= penalty;

        // =====================================
        // DEAD / ABANDONED PROJECT HARD CAP
        // =====================================

        const deadProject =
            (trades24h!==null && trades24h<5)
            &&
            volumeH24<5000;

        if(deadProject){

            risks.push("Very low activity - possible dead or abandoned project");

        }

        // =====================================
        // FINAL SCORE
        // =====================================

        score=Math.max(

            0,

            Math.min(

                Math.round(score),

                100

            )

        );

        if(deadProject){

            score = Math.min(score, 35);

        }

        // Exponential Smoothing (ROI audit item 6): anti-flicker,
        // not latency. alpha=0.6 deliberately favors THIS scan's
        // reading over history, so a genuine fast move still
        // shows up strongly on the very next scan - it just
        // stops a single noisy reading from swinging the score
        // (and the action tier derived from it) on its own. The
        // very first time a token is seen, there's no prior
        // value to smooth against, so it's simply the raw score
        // - never delayed on first sight.

        const rawScore = score;

        // V14 asymmetric smoothing: a RISING raw score passes
        // through almost immediately (alpha 0.85) so a newborn
        // pump is never slowed down by its own history, while a
        // FALLING raw score is damped harder (alpha 0.5) - which
        // is where flicker actually hurts (BUY blinking off from
        // one noisy scan). Anti-flicker without entry lag.

        if(previousMemory?.smoothedScore != null){

            const alpha = rawScore >= previousMemory.smoothedScore ? 0.85 : 0.5;

            score = Math.round(

                alpha * rawScore +

                (1 - alpha) * previousMemory.smoothedScore

            );

        }

        // =====================================
        // CONFIDENCE
        // Not just from the raw size of the metrics -
        // also from data COMPLETENESS (how many
        // timeframes are actually available) and
        // direction CONSISTENCY across timeframes. Thin
        // or contradictory data means low confidence,
        // even if the numbers themselves look good.
        // =====================================

        let liqConf=0;

        if(liquidity>=1000000){liqConf=20;}
        else if(liquidity>=500000){liqConf=16;}
        else if(liquidity>=200000){liqConf=12;}
        else if(liquidity>=100000){liqConf=8;}
        else if(liquidity>=30000){liqConf=4;}
        else{liqConf=0;}

        let holderConf=0;

        if(holder===null){holderConf=10;}
        else if(holder>=10000){holderConf=20;}
        else if(holder>=5000){holderConf=16;}
        else if(holder>=2000){holderConf=12;}
        else if(holder>=500){holderConf=8;}
        else if(holder>=100){holderConf=4;}
        else{holderConf=0;}

        let tradesConf=0;

        if(trades1h===null){tradesConf=10;}
        else if(trades1h>=500){tradesConf=20;}
        else if(trades1h>=200){tradesConf=16;}
        else if(trades1h>=50){tradesConf=12;}
        else if(trades1h>=10){tradesConf=6;}
        else{tradesConf=0;}

        let volConf=0;

        if(volumeH24>=1000000){volConf=20;}
        else if(volumeH24>=500000){volConf=16;}
        else if(volumeH24>=200000){volConf=12;}
        else if(volumeH24>=50000){volConf=8;}
        else if(volumeH24>=20000){volConf=4;}
        else{volConf=0;}

        let momentumConf=0;

        if(momentum<0){momentumConf=0;}
        else if(momentum<10){momentumConf=8;}
        else if(momentum<30){momentumConf=14;}
        else if(momentum<80){momentumConf=20;}
        else if(momentum<200){momentumConf=12;}
        else{momentumConf=5;}

        // Data completeness: how many of 8 real data
        // points are actually available for this token.

        let dataPoints = 0;

        if(pair.priceChange?.m5!=null) dataPoints++;
        if(pair.priceChange?.h1!=null) dataPoints++;
        if(pair.priceChange?.h6!=null) dataPoints++;
        if(pair.priceChange?.h24!=null) dataPoints++;
        if(buyRatio!=null) dataPoints++;
        if(buyRatio1h!=null) dataPoints++;
        if(buyRatio5!=null) dataPoints++;
        if(pair.pairCreatedAt!=null) dataPoints++;

        const completeness = dataPoints/8;

        // Direction agreement: do m5/h1/h6/h24 all point
        // the same way (all up or all down), or contradict
        // each other.

        const directionSigns =
            [p5,p1,p6,p24]
            .filter(v=>Math.abs(v)>0.01)
            .map(v=>v>0?1:-1);

        const agreement =
            directionSigns.length
            ? directionSigns.filter(s=>s===directionSigns[0]).length/directionSigns.length
            : 0.5;

        const dataQualityAdj =
            Math.round((completeness*12) + (agreement*12) - 12);

        let confidence =

            liqConf+

            holderConf+

            tradesConf+

            volConf+

            momentumConf-

            penalty+

            dataQualityAdj;

        // V14 (multi-scan confirmation as a BOOSTER, not a gate):
        // a token that has ALREADY been sitting at BUY-tier for
        // consecutive scans has proven persistence - reward that
        // with extra confidence. Crucially this only ADDS trust
        // to signals that already fired; it never delays the
        // first entry, which fires at full speed on scan one.

        if(priorBuyStreak >= 1){

            confidence += Math.min(12, 4 + priorBuyStreak * 4);

        }

        confidence = Math.max(

            5,

            Math.min(

                Math.round(confidence),

                99

            )

        );

        if(deadProject){

            confidence = Math.min(confidence, 30);

        }

        // =====================================
        // TARGET (more conservative when confidence
        // is low - not purely a function of score)
        // =====================================

        // V12 change (Priority #2): this used to be
        // score*0.45, which routinely produced +40-60% targets
        // - exciting on paper, but unrealistic often enough
        // that it set the wrong expectation. Lower multiplier +
        // a hard cap now aim for smaller, more consistently
        // achievable exits (~12-25% typical) instead of chasing
        // big numbers. A floor of 5% keeps the figure meaningful
        // even for lower-scoring qualifying entries.

        const target = Math.min(

            25,

            Math.max(

                5,

                Math.round(

                    score * 0.22 * Math.min(1, confidence/70)

                )

            )

        );

        const targetMC = Math.round(

            fdv * (1 + target / 100)

        );

        // =====================================
        // AI DECISION - standardized to exactly 4
        // signal values: STRONG BUY, BUY, HOLD, AVOID.
        // `signal` (used for the UI badge/color) is the
        // same value as `action` - one vocabulary, used
        // identically everywhere (cards, filters, history,
        // detail panel).
        // =====================================

        let action = "AVOID";

        // V14 (early-detection objective): thresholds lowered so the
        // engine commits to newborn winners earlier. STRONG BUY
        // 88->85 & conf 65->58; BUY 68->62, penalty tolerance
        // 8->10, conf 45->40. Protection against obvious rugs is
        // handled by hard-blocks + the new absolute-liquidity
        // check, not by keeping these gates high.

        if(score>=85 && penalty<=4 && confidence>=58){

            action = "STRONG BUY";

        }
        else if(score>=62 && penalty<=10 && confidence>=40){

            action = "BUY";

        }
        else if(score>=40){

            action = "HOLD";

        }

        // Hard blocks - regardless of score, never allow
        // STRONG BUY/BUY when these conditions are true.

        if(hardBlockBuy){

            if(action==="STRONG BUY" || action==="BUY"){

                action = "HOLD";

            }

        }
        else if(hardBlockStrongBuy){

            if(action==="STRONG BUY"){

                action = "BUY";

            }

        }

        // Low confidence = never a BUY-tier signal.

        if(confidence<34 && (action==="STRONG BUY" || action==="BUY")){

            action = "HOLD";
            risks.push("Confidence too low - BUY signal downgraded to Hold");

        }

        if(deadProject){

            action = "AVOID";

        }

        const signal = action;

        let risk = "LOW";

        if(penalty >= 12 || confidence<35){

            risk = "HIGH";

        }
        else if(penalty >= 5 || confidence<55){

            risk = "MEDIUM";

        }

        if(deadProject){

            risk = "HIGH";

        }

        let summary = "";

        if(deadProject){

            summary="Almost no real trading activity - treat as inactive.";

        }
        else if(action=="STRONG BUY"){

            summary="Coin quality and buy timing are both strong, with high confidence.";

        }
        else if(action=="BUY"){

            summary="Good quality with healthy timing.";

        }
        else if(action=="HOLD"){

            summary="Worth watching - not yet a confirmed entry point.";

        }
        else{

            summary="Risk currently outweighs the potential reward.";

        }

        // ROI audit items 3/4/5/6: persist this scan's values so
        // the NEXT call to analyze() for this same address can
        // compute delta-momentum, apply exponential smoothing,
        // and evaluate multi-scan confirmation streaks. Skipped
        // if we don't have an address to key by (shouldn't
        // normally happen, but analyze() must never throw over
        // missing optional data).

        if(address){

            const qualifiesBuyTier = (action === "STRONG BUY" || action === "BUY");

            this._touchMemory(address, {

                lastMomentum: momentum,

                smoothedScore: score,

                distributionStreak,

                downtrendStreak,

                buyStreak: qualifiesBuyTier ? priorBuyStreak + 1 : 0

            });

        }

        // =====================================
        // RETURN - same contract as V10 (every key
        // below is unchanged; only `action`/`signal`
        // now use the standardized 4-value vocabulary)
        // =====================================

        return{

            score,

            rawScore,

            confidence,

            signal,

            action,

            risk,

            summary,

            penalty,

            target,

            targetMC,

            momentumScore,

            liquidityScore,

            ratioScore,

            fdvScore,

            backingScore,

            holderScore,

            tradesScore,

            buySellScore,

            liquidity,

            volume: volumeH24,

            fdv,

            ratio,

            momentum,

            liqPercent,

            holder,

            trades1h,

            trades24h,

            buys24h,

            sells24h,

            buyRatio,

            deadProject,

            // Additive only (V12) - these were already computed
            // internally for scoring/confidence but never
            // returned. Exposing them lets the UI show WHY the
            // engine trusts a signal using real, already-computed
            // diagnostics instead of re-deriving anything new.

            decelerating,

            volumeAccelerating,

            volumeExhausting,

            isAccumulating,

            deltaMomentum,

            breakoutProbability,

            pctBelowSessionPeak,

            alreadyHadBigMove,

            accumulationTier,

            buyerDominanceIncreasing,

            manySmallTrades,

            largeBuyerActivity,

            distributionForming,

            historyTrend,

            dataCompleteness: completeness,

            dataAgreement: agreement,

            reasons,

            risks

        };

    }

};
