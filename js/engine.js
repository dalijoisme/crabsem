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

        // "Decelerating": the last 5 minutes, projected
        // to an hourly rate, is already weaker than the
        // 1h window that's supposedly still positive -
        // this is the exact pattern behind a pump that
        // has quietly turned over.

        const p5HourlyRate = p5 * 12;

        const decelerating = p1 > 0 && p5HourlyRate < 0;

        let momentumScore = 0;

        if(momentum>=60){

            momentumScore=30;
            reasons.push("Explosive momentum across all timeframes");

        }

        else if(momentum>=35){

            momentumScore=24;
            reasons.push("Strong bullish trend");

        }

        else if(momentum>=20){

            momentumScore=19;
            reasons.push("Bullish momentum");

        }

        else if(momentum>=10){

            momentumScore=14;

        }

        else if(momentum>=5){

            momentumScore=9;

        }

        else if(momentum>=0){

            momentumScore=4;

        }

        else if(momentum>=-10){

            momentumScore=1;

        }

        else{

            momentumScore=0;
            risks.push("Heavy selling pressure");

        }

        if(decelerating){

            momentumScore = Math.max(0, momentumScore-8);

            risks.push(`Momentum weakening - last 5 minutes ${p5.toFixed(1)}% while the 1h window is still ${p1.toFixed(1)}%`);

        }

        else if(p5>0 && p1>0 && (p5*12) > p1){

            momentumScore = Math.min(30, momentumScore+3);
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

        score+=holderScore;

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
        // BUY / SELL PRESSURE (Buy Timing) -
        // checked across 3 timeframes (5m/1h/24h)
        // to catch distribution that just started,
        // not only the 24h snapshot.
        // =====================================

        let buySellScore=0;

        if(buyRatio===null){

            buySellScore=2;

        }

        else if(buyRatio>=0.65){

            buySellScore=5;
            reasons.push("Buy pressure dominant");

        }

        else if(buyRatio>=0.55){

            buySellScore=4;

        }

        else if(buyRatio>=0.45){

            buySellScore=2;

        }

        else if(buyRatio>=0.35){

            buySellScore=1;

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

            buySellScore = Math.max(0, buySellScore-3);

            risks.push(`Selling pressure rising - current buy ratio ${Math.round(recentBuyRatio*100)}% (24h still ${Math.round(buyRatio*100)}%)`);

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

        if(momentum>=30)
            bonus+=2;

        if(isEarlyGem && volumeAccelerating)
            bonus+=3;

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

        // Price is actively dropping SHARPLY right now
        // (last 5 minutes) - the most direct signal, and
        // the one most often missed by a snapshot-only
        // engine.

        if(p5 <= -4){

            penalty += 10;
            hardBlockBuy = true;
            risks.push(`Price dropped ${p5.toFixed(1)}% in the last 5 minutes`);

        }
        else if(p5 <= -1.5){

            penalty += 4;
            hardBlockStrongBuy = true;

        }

        if(momentum < 0){

            hardBlockStrongBuy = true;

        }

        // Repeated downward pattern in our own session
        // history (real, not just a snapshot).

        if(historyTrend && historyTrend.totalSteps>=2 && historyTrend.lowerSteps > historyTrend.higherSteps){

            penalty += 5;
            hardBlockStrongBuy = true;
            risks.push("A downward price pattern was detected during this monitoring session");

        }

        // Distribution just starting - never give a
        // STRONG BUY while the token is being sold into.

        if(distributionForming){

            penalty += 5;
            hardBlockStrongBuy = true;

        }

        // Large volume while price falls = active
        // distribution.

        if(p24 < -5 && ratio>=2){

            penalty += 6;
            hardBlockBuy = true;
            risks.push("Large volume while price is falling - sign of active distribution");

        }

        if(p24 >= 500){

            penalty += 15;
            risks.push("Already pumped significantly");
            hardBlockStrongBuy = true;

        }

        else if(p24 >= 250){

            penalty += 8;
            risks.push("Very extended price move");
            hardBlockStrongBuy = true;

        }

        else if(p24 >= 120){

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

            penalty += 5;
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

        const target = Math.round(

            score * 0.45 * Math.min(1, confidence/70)

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

        if(score>=88 && penalty<=3 && confidence>=65){

            action = "STRONG BUY";

        }
        else if(score>=68 && penalty<=8 && confidence>=45){

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

        if(confidence<40 && (action==="STRONG BUY" || action==="BUY")){

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

        // =====================================
        // RETURN - same contract as V10 (every key
        // below is unchanged; only `action`/`signal`
        // now use the standardized 4-value vocabulary)
        // =====================================

        return{

            score,

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

            reasons,

            risks

        };

    }

};
