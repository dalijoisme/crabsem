// =====================================
// CRAB AGENT ENGINE V10
// COIN QUALITY + BUY TIMING + CONFIDENCE
//
// Kontrak return TIDAK berubah dari V9 (semua key lama
// tetap ada, dengan nilai/skala yang sama) supaya ui.js
// (scoreBar() dengan max hardcoded, badge HOT/GEM/WATCH/
// RISK, dsb) tidak perlu disentuh sama sekali.
//
// Yang berubah adalah BAGAIMANA tiap komponen dihitung:
//
// 1) COIN QUALITY - "apakah coin ini layak dipantau?"
//    liquidityScore, fdvScore, backingScore, holderScore
//    (holder tetap null - tidak ada sumber data holder
//    gratis, jujur ditampilkan "-", tidak dihukum/diberi
//    bonus palsu)
//
// 2) BUY TIMING - "apakah SEKARANG waktu tepat?"
//    momentumScore, ratioScore, tradesScore, buySellScore
//    -sekarang memakai priceChange.m5/h1/h6/h24 (REAL,
//    field asli DexScreener yang sebelumnya tidak pernah
//    dibaca), txns.m5/h1/h24 buy-sell split per-timeframe,
//    volume h1 vs rata-rata h24, dan pairCreatedAt (umur
//    token, REAL field) untuk early-gem detection.
//
// 3) CONFIDENCE - dihitung dari kelengkapan data (berapa
//    timeframe yang benar-benar tersedia) DAN konsistensi
//    arah antar timeframe (m5/h1/h6/h24 searah atau saling
//    bertentangan), bukan cuma dari besaran metrik.
//
// HARD BLOCKS - beberapa kondisi memaksa action turun
// beberapa tingkat TIDAK PEDULI berapapun skor mentahnya:
// harga sedang jatuh di 5 menit terakhir, distribusi
// (buy ratio jangka pendek jauh lebih lemah dari 24h),
// fake breakout (harga naik tapi buy pressure lemah),
// dead bounce (pantulan kecil di tengah downtrend).
// Ini yang mencegah kasus "score tinggi tapi chart lagi
// jatuh" seperti yang dilaporkan.
//
// Semua input di bawah adalah field ASLI DexScreener
// (priceChange.{m5,h1,h6,h24}, volume.{m5,h1,h6,h24},
// txns.{m5,h1,h6,h24}.{buys,sells}, pairCreatedAt) atau
// histori sesi kita sendiri (pair.__priceHistory, diisi
// oleh api.js dari hasil scan nyata, session-only). Tidak
// ada angka yang direka.
// =====================================

const Engine = {

    analyze(pair){

        // =====================================
        // CORE DATA (semua field asli DexScreener)
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

        // Multi-timeframe price change - m5 & h6 baru
        // dipakai mulai V10, sebelumnya cuma h1/h24.

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

        // Buy/Sell split per-timeframe - real DexScreener
        // txns data. 24h dari pair.trades (sudah dihitung
        // di api.js), 1h & 5m langsung dari pair.txns.

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

        // Age - real DexScreener field (pairCreatedAt),
        // never used before V10.

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
        // rata-rata per-jam dari h24)
        // =====================================

        const expectedHourlyVol = volumeH24 / 24;

        const volumeAccelerating =
            expectedHourlyVol > 0 && volumeH1 > expectedHourlyVol * 1.6;

        const volumeExhausting =
            expectedHourlyVol > 0 && volumeH1 < expectedHourlyVol * 0.35 && p24 >= 15;

        // =====================================
        // SESSION HISTORY TREND (real, kasar ~60s
        // per sample, hanya aktif setelah cukup data)
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
            reasons.push("Explosive momentum di semua timeframe");

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

            risks.push(`Momentum melemah - 5 menit terakhir ${p5.toFixed(1)}% padahal 1 jam masih ${p1.toFixed(1)}%`);

        }

        else if(p5>0 && p1>0 && (p5*12) > p1){

            momentumScore = Math.min(30, momentumScore+3);
            reasons.push("Momentum berakselerasi di jangka pendek");

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

            reasons.push(`Volume 1 jam ${multiplier}x di atas rata-rata harian`);

        }

        else if(volumeExhausting){

            ratioScore = Math.max(0, ratioScore-3);

            risks.push("Volume melemah meski harga masih tinggi - kemungkinan exhaustion");

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

        // Liquidity trend dari histori sesi (real, kalau
        // sudah cukup data terkumpul)

        if(historyTrend){

            if(historyTrend.liquidityTrendPercent <= -10){

                liquidityScore = Math.max(0, liquidityScore-4);

                risks.push(`Liquidity turun ${Math.abs(historyTrend.liquidityTrendPercent).toFixed(1)}% selama sesi pemantauan`);

            }

            else if(historyTrend.liquidityTrendPercent >= 10){

                liquidityScore = Math.min(15, liquidityScore+2);

                reasons.push(`Liquidity naik ${historyTrend.liquidityTrendPercent.toFixed(1)}% selama sesi pemantauan`);

            }

        }

        score+=liquidityScore;

        // =====================================
        // FDV / VALUATION (Coin Quality, + early
        // gem consideration dari umur pair - real
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

            reasons.push(`Token masih baru (${ageHours<24 ? Math.round(ageHours)+"h" : Math.round(ageHours/24)+"d"}) dengan valuasi kecil`);

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
        // HOLDER (Coin Quality) - tetap null, tidak
        // ada sumber data holder gratis. Netral, tidak
        // menghukum maupun memberi bonus palsu.
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
        // TRADES / FREKUENSI (Buy Timing)
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
        // sekarang dicek di 3 timeframe (5m/1h/24h)
        // untuk mendeteksi distribusi yang baru mulai,
        // bukan cuma snapshot 24h.
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

        // Distribusi baru mulai: 24h masih terlihat sehat
        // tapi 1h/5m sudah berbalik ke sell-dominant.

        const recentBuyRatio =
            buyRatio5 != null ? buyRatio5 :
            buyRatio1h != null ? buyRatio1h :
            null;

        const distributionForming =
            buyRatio!=null && buyRatio>=0.5 &&
            recentBuyRatio!=null && recentBuyRatio<0.4;

        if(distributionForming){

            buySellScore = Math.max(0, buySellScore-3);

            risks.push(`Tekanan jual meningkat - buy ratio terkini ${Math.round(recentBuyRatio*100)}% (24h masih ${Math.round(buyRatio*100)}%)`);

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

            reasons.push("Harga cenderung naik di beberapa scan terakhir sesi ini");

        }

        score+=bonus;

        // =====================================
        // PENALTY + HARD BLOCKS
        // Kondisi di bawah ini TIDAK PERNAH boleh
        // menghasilkan STRONG BUY / BUY, apapun skor
        // mentahnya - inilah yang memperbaiki kasus
        // "score tinggi tapi chart sedang jatuh".
        // =====================================

        let penalty = 0;

        let hardBlockBuy = false;
        let hardBlockStrongBuy = false;

        // Harga sedang jatuh TAJAM saat ini juga (5 menit
        // terakhir) - sinyal paling langsung dan paling
        // sering terlewat oleh engine lama.

        if(p5 <= -4){

            penalty += 10;
            hardBlockBuy = true;
            risks.push(`Harga turun ${p5.toFixed(1)}% dalam 5 menit terakhir`);

        }
        else if(p5 <= -1.5){

            penalty += 4;
            hardBlockStrongBuy = true;

        }

        if(momentum < 0){

            hardBlockStrongBuy = true;

        }

        // Pola turun berulang di histori sesi kita sendiri
        // (real, bukan cuma snapshot)

        if(historyTrend && historyTrend.totalSteps>=2 && historyTrend.lowerSteps > historyTrend.higherSteps){

            penalty += 5;
            hardBlockStrongBuy = true;
            risks.push("Pola harga menurun terdeteksi pada sesi pemantauan ini");

        }

        // Distribusi yang baru mulai - jangan pernah kasih
        // STRONG BUY kalau sedang dijual.

        if(distributionForming){

            penalty += 5;
            hardBlockStrongBuy = true;

        }

        // Volume besar tapi harga turun = distribusi aktif

        if(p24 < -5 && ratio>=2){

            penalty += 6;
            hardBlockBuy = true;
            risks.push("Volume besar sementara harga turun - indikasi distribusi");

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

        // Fake breakout: harga naik kencang tapi buy
        // pressure jangka pendek lemah - breakout tidak
        // didukung pembeli nyata.

        if(p24>=40 && buyRatio5!=null && buyRatio5<0.4){

            penalty += 8;
            hardBlockStrongBuy = true;
            hardBlockBuy = true;
            risks.push("Kemungkinan fake breakout - harga naik tapi buy pressure lemah");

        }

        // Dead bounce: pantulan kecil di tengah downtrend
        // yang masih dalam (h1 & h24 sama-sama negatif
        // dalam, m5 baru saja positif tipis).

        if(p5>0 && p1<=-8 && p24<=-8){

            penalty += 8;
            hardBlockStrongBuy = true;
            hardBlockBuy = true;
            risks.push("Dead bounce - pantulan kecil di tengah downtrend");

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
        // Bukan cuma dari besaran metrik - juga dari
        // KELENGKAPAN data (berapa timeframe yang benar-
        // benar tersedia) dan KONSISTENSI arah antar
        // timeframe. Data yang sedikit/kontradiktif =
        // confidence rendah, meskipun angka-angkanya
        // sendiri terlihat bagus.
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

        // Kelengkapan data: berapa dari 8 titik data
        // real yang benar-benar tersedia untuk token ini.

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

        // Konsistensi arah: apakah m5/h1/h6/h24 sepakat
        // arahnya (semua naik atau semua turun), atau
        // saling bertentangan.

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
        // TARGET (lebih konservatif kalau confidence
        // rendah - bukan cuma fungsi dari score)
        // =====================================

        const target = Math.round(

            score * 0.45 * Math.min(1, confidence/70)

        );

        const targetMC = Math.round(

            fdv * (1 + target / 100)

        );

        // =====================================
        // AI DECISION - 7 tingkat sesuai permintaan.
        // Signal (badge UI) tetap dipetakan ke 4 nilai
        // lama (HOT/GEM/WATCH/RISK) supaya tampilan
        // tidak berubah.
        // =====================================

        let action = "AVOID";

        if(score>=88 && penalty<=3 && confidence>=65){

            action = "STRONG BUY";

        }
        else if(score>=75 && penalty<=6 && confidence>=55){

            action = "BUY";

        }
        else if(score>=62 && confidence>=45){

            action = "ACCUMULATE";

        }
        else if(score>=48){

            action = "WATCH";

        }
        else if(score>=32){

            action = "NEUTRAL";

        }
        else if(score>=18){

            action = "WEAK";

        }

        // Hard blocks - tidak peduli skor, jangan pernah
        // kasih STRONG BUY/BUY kalau kondisi ini terjadi.

        if(hardBlockBuy){

            if(action==="STRONG BUY" || action==="BUY" || action==="ACCUMULATE"){

                action = "WATCH";

            }

        }
        else if(hardBlockStrongBuy){

            if(action==="STRONG BUY" || action==="BUY"){

                action = "ACCUMULATE";

            }

        }

        // Confidence rendah = jangan pernah BUY-tier.

        if(confidence<40 && (action==="STRONG BUY" || action==="BUY")){

            action = "ACCUMULATE";
            risks.push("Confidence rendah - sinyal BUY diturunkan ke Accumulate");

        }

        if(deadProject){

            action = "AVOID";

        }

        // Petakan ke badge lama (4 nilai, warna sudah
        // dikenal user - tidak diubah).

        let signal = "RISK";

        if(action==="STRONG BUY"){

            signal = "HOT";

        }
        else if(action==="BUY" || action==="ACCUMULATE"){

            signal = "GEM";

        }
        else if(action==="WATCH" || action==="NEUTRAL"){

            signal = "WATCH";

        }

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

            summary="Coin quality dan buy timing sama-sama kuat, confidence tinggi.";

        }
        else if(action=="BUY"){

            summary="Kualitas baik dengan timing yang sehat.";

        }
        else if(action=="ACCUMULATE"){

            summary="Positif tapi belum sepenuhnya terkonfirmasi - bangun posisi bertahap.";

        }
        else if(action=="WATCH"){

            summary="Layak dipantau, belum entry point yang jelas.";

        }
        else if(action=="NEUTRAL"){

            summary="Tidak ada sinyal kuat ke arah manapun.";

        }
        else if(action=="WEAK"){

            summary="Fundamental atau timing lemah - keyakinan rendah.";

        }
        else{

            summary="Risiko saat ini lebih besar dari potensi.";

        }

        // =====================================
        // RETURN - kontrak sama persis dengan V9
        // (semua key lama tetap ada, nilai/skala sama)
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
