// =====================================
// ENTRY STAGE ESTIMATION
// (frontend-only heuristic on top of the
// existing Engine signal - does not touch
// engine.js)
// =====================================

function estimateEntryStage(signal){

    const fdv = signal.fdv || 0;

    const penalty = signal.penalty || 0;

    const momentum = signal.momentum || 0;

    const liqPercent = signal.liqPercent || 0;

    const ratio = signal.ratio || 0;

    if(signal.deadProject){

        return{ key:"late", className:"late", label:"LATE" };

    }

    // Hard "late" conditions - already extended
    // / overheated / valuation too big to be early.

    if(penalty>=8 || fdv>15000000 || momentum>=150){

        return{ key:"late", className:"late", label:"LATE" };

    }

    let points = 0;

    if(fdv<=3000000) points+=2;
    else if(fdv<=10000000) points+=1;

    if(penalty===0) points+=2;
    else if(penalty<=3) points+=1;

    if(liqPercent>=15) points+=1;

    if(momentum>=10 && momentum<60) points+=2;
    else if(momentum>=60) points-=1;

    if(ratio>=1 && ratio<10) points+=1;

    if(points>=5){

        return{ key:"early", className:"early", label:"EARLY" };

    }

    return{ key:"mid", className:"mid", label:"MID" };

}

// =====================================
// PRICE FORMAT (handles small meme prices)
// =====================================

function formatPrice(v){

    const n = Number(v || 0);

    if(n<=0) return "-";

    if(n>=1) return "$"+n.toFixed(2);

    if(n>=0.001) return "$"+n.toFixed(5);

    return "$"+n.toExponential(2);

}

// =====================================
// MARKET CAP DISPLAY
// Never show FDV under the "Market Cap"
// label. If a real market cap isn't
// available, show N/A explicitly.
// =====================================

function marketCapLabelValue(pair, signal){

    const raw = Number(pair.marketCap || 0);

    if(raw > 0){

        return format(raw);

    }

    return "N/A";

}

// =====================================
// DEXSCREENER LINK
// Prefer the pair's own native URL (exact
// pool that produced the numbers shown).
// =====================================

function dexscreenerLink(pair){

    if(pair.url){

        return pair.url;

    }

    return `https://dexscreener.com/solana/${pair.baseToken.address}`;

}

// =====================================
// GMGN LINK
// Referral code lives in config.js only.
// Built dynamically per token contract.
// =====================================

function gmgnLink(pair){

    const code = CONFIG?.GMGN_REFERRAL_CODE || "";

    const address = pair.baseToken?.address || "";

    if(!address) return "https://gmgn.ai/";

    return `https://gmgn.ai/sol/token/${code}_${address}`;

}

const UI = {

    // =====================================
    // CARD
    // =====================================

    renderCard(pair, rank){

        const signal = pair.signal;

        const logo =
        pair.info?.imageUrl ||
        pair.logoURI ||
        "images/body.png";

        const medal =
            rank===1 ? "🥇" :
            rank===2 ? "🥈" :
            rank===3 ? "🥉" :
            null;

        const rankLabel =
            medal ? medal : (rank ? `#${rank}` : "");

        const color = {

            "STRONG BUY":"#16c784",

            "BUY":"#8b5cf6",

            "HOLD":"#f5a623",

            "AVOID":"#ff4d4d"

        }[signal.signal] || "#ff4d4d";

        const badge = {

            "STRONG BUY":"🚀 STRONG BUY",

            "BUY":"✅ BUY",

            "HOLD":"👀 HOLD",

            "AVOID":"⚠ AVOID"

        }[signal.signal] || "⚠ AVOID";

        const badgeClass = {

            "STRONG BUY":"strong-buy",

            "BUY":"buy",

            "HOLD":"hold",

            "AVOID":"avoid"

        }[signal.signal] || "avoid";

        const stage = estimateEntryStage(signal);

        const card=document.createElement("div");

        card.className="coinCard";

        card.innerHTML=`

        ${rankLabel ? `<div class="rankBadge${medal?" medal":""}">${rankLabel}</div>` : ""}

        <div class="entryBadge ${stage.className}">${stage.label}</div>

        <div class="coinHeader">

            <img src="${logo}" class="coinLogo">

            <div>

                <h3>${pair.baseToken.symbol}</h3>

                <small>${pair.baseToken.name}</small>

            </div>

            <span style="color:${pair.priceChange?.h24>=0?"#16c784":"#ff4d4d"}">

                ${pair.priceChange?.h24?.toFixed(2) || 0}%

            </span>

        </div>

        <div class="coinInfo">

            <div>

                Vol

                <br>

                <strong>$${format(pair.volume?.h24)}</strong>

            </div>

            <div>

                Liq

                <br>

                <strong>$${format(pair.liquidity?.usd)}</strong>

            </div>

            <div>

                MCap

                <br>

                <strong>${pair.marketCap>0 ? "$"+format(pair.marketCap) : "N/A"}</strong>

            </div>

        </div>

        <div class="signalBox" style="border-color:${color}">

            <small class="scoreLabel">CRAB SCORE</small>

            <h2 class="scoreValue" style="color:${color}">${signal.score}</h2>

            <div class="signalPill" style="background:${color}">${signal.signal}</div>

            <div class="signalMetaRow">

                <span>Strength ${signal.confidence}%</span>

                <span>+${signal.target}%</span>

            </div>

            <div class="signalTargetMC">

                Target MC $${format(signal.targetMC)}

            </div>

        </div>

        <div class="statusBadge ${badgeClass}">

            ${badge}

        </div>

        <div class="dexBadge">

            ${(pair.dexId||"dex").toUpperCase()}

        </div>

        `;

        card.onclick=()=>showDetail(pair);

        return card;

    },

    // =====================================
    // DETAIL PANEL
    // =====================================

    renderDetail(pair){

        const signal = pair.signal;

        const color = {

            "STRONG BUY":"#16c784",

            "BUY":"#8b5cf6",

            "HOLD":"#f5a623",

            "AVOID":"#ff4d4d"

        }[signal.signal] || "#ff4d4d";

        const logo =
            pair.info?.imageUrl ||
            pair.logoURI ||
            "images/body.png";

        const stage = estimateEntryStage(signal);

        const price = Number(pair.priceUsd || 0);

        const stopLossPercent =
            signal.risk==="HIGH" ? 22 :
            signal.risk==="MEDIUM" ? 14 : 8;

        // TP/SL now expressed as Market Cap, not token price -
        // same underlying growth multiple as before (price and
        // FDV scale together), just a more intuitive unit for
        // a meme coin audience. targetMC is already fdv*(1+
        // target/100) from the engine - takeProfitMC reuses it
        // directly since "take profit at the target" is the
        // same number as "target market cap".

        const takeProfitMC = signal.targetMC;

        const stopLossMC =
            signal.fdv * (1 - stopLossPercent/100);

        const riskTierValue =
            signal.risk==="HIGH" ? 90 :
            signal.risk==="MEDIUM" ? 60 : 25;

        // Confidence Breakdown (V12, Priority #3) - explains WHY
        // the AI trusts (or doesn't trust) this signal, using
        // real diagnostics the engine already computes but
        // didn't expose before now (see engine.js return object).
        // Deliberately different framing from the CRAB SCORE
        // Breakdown further down, which explains HOW the score
        // itself was calculated.

        const entryTimingPct =
            stage.key==="early" ? 88 :
            stage.key==="mid" ? 55 : 18;

        const momentumQualityPct =
            Math.round((signal.momentumScore/20)*100);

        const marketStructurePct =
            Math.round((signal.backingScore/10)*100);

        const buyerDominancePct =
            signal.buyRatio!=null ? Math.round(signal.buyRatio*100) : 50;

        const breakoutProbPct = Math.min(100, Math.round(

            (signal.volumeAccelerating ? 40 : 10) +

            (signal.isAccumulating ? 30 : 0) +

            ((signal.buySellScore/23) * 30)

        ));

        const trendStabilityPct =
            (!signal.historyTrend || signal.historyTrend.totalSteps<=0)
            ? 50
            : Math.round((signal.historyTrend.higherSteps/signal.historyTrend.totalSteps)*100);

        const trendStabilityNote =
            (!signal.historyTrend || signal.historyTrend.totalSteps<=0)
            ? "Not enough scans yet this session - showing neutral"
            : null;

        const patternReliabilityPct = Math.round(

            ((signal.dataCompleteness||0) + (signal.dataAgreement||0)) / 2 * 100

        );

        const signalFreshnessText =
            pair.__changed ? "Just updated this scan" : "Stable across recent scans";

        const isBuyTier =
            signal.action==="STRONG BUY" || signal.action==="BUY";

        const isHold =
            signal.action==="HOLD";

        // AVOID-tier labels: only show the specific ones that
        // actually apply, based on the real risks[] strings the
        // engine already produced - not a blanket static list.

        const risksText =
            (signal.risks || []).join(" ").toLowerCase();

        const avoidFlags = [];

        if(risksText.includes("distribution") || risksText.includes("sold into") || risksText.includes("sell pressure")){

            avoidFlags.push("Possible Distribution");

        }

        if(risksText.includes("extended") || risksText.includes("pumped") || risksText.includes("fake breakout")){

            avoidFlags.push("Overextended Move");

        }

        avoidFlags.push("High Downside Risk", "Avoid New Entry");

        const avoidFlagsHtml =
            avoidFlags.map(f=>

                `<div class="monitorRow"><span>${f}</span><strong class="changedYes">⚠</strong></div>`

            ).join("");

        const whyItems =
            (signal.reasons && signal.reasons.length)
            ? signal.reasons
            : ["No strong standout factor yet"];

        const whyHtml =
            whyItems.map(r=>

                `<li><span class="tick">✓</span>${r}</li>`

            ).join("");

        const riskHtml =
            (signal.risks && signal.risks.length)
            ? signal.risks.map(r=>

                `<li><span class="tick">✕</span>${r}</li>`

            ).join("")
            : "";

        const holderDisplay =
            signal.holder!=null
            ? format(signal.holder)
            : "-";

        const trades24hDisplay =
            signal.trades24h!=null
            ? format(signal.trades24h)
            : (
                signal.trades1h!=null
                ? format(Math.round(signal.trades1h*24))+"*"
                : "-"
            );

        const marketCapDisplay =
            marketCapLabelValue(pair, signal);

        const buyPct =
            signal.buyRatio!=null
            ? Math.round(signal.buyRatio*100)
            : null;

        const buySellHtml =
            buyPct!=null
            ? `

            <div class="buySellBar">

                <div class="buySellFill" style="width:${buyPct}%"></div>

            </div>

            <div class="buySellLabels">

                <span>${buyPct}% Buy</span>

                <span>${100-buyPct}% Sell</span>

            </div>

            `
            : `<div class="disclaimerNote">Buy/Sell split unavailable for this pair.</div>`;

        const history =
            (pair.__history && pair.__history.length)
            ? pair.__history
            : [{ action: signal.action, time: Date.now() }];

        const historyHtml =
            history.map((h,i)=>{

                const isCurrent = i===history.length-1;

                const timeLabel =
                    new Date(h.time).toLocaleTimeString();

                return `

                <div class="historyStep ${isCurrent?"current":""}">

                    <strong>${h.action}</strong>

                    <span>${timeLabel}</span>

                </div>

                `;

            }).join("");

        const dexUrl = dexscreenerLink(pair);

        const gmgnUrl = gmgnLink(pair);

        if(typeof Analytics !== "undefined"){

            Analytics.track("detail_open");

        }

        return `

        <div class="detailHeader">

            <img src="${logo}" width="64" style="border-radius:50%">

            <div class="detailHeaderInfo">

                <h2>${pair.baseToken.name}</h2>

                <span>${pair.baseToken.symbol}</span>

            </div>

        </div>

        <div style="
            display:inline-block;
            background:${color};
            color:white;
            padding:8px 18px;
            border-radius:999px;
            font-weight:700;
            margin:14px 0 4px 0;
        ">

            ${signal.action}

        </div>

        <div class="disclaimerNote">

            Algorithmic signal, not financial advice.

        </div>

        <div style="font-size:12px;color:#8d90a8;margin-top:8px;">

            CRAB SCORE ${signal.score} · Signal Strength ${signal.confidence}%

        </div>

        <div class="entryMeter">

            <div class="${stage.key==="early"?"active early":""}">EARLY</div>

            <div class="${stage.key==="mid"?"active mid":""}">MID</div>

            <div class="${stage.key==="late"?"active late":""}">LATE</div>

        </div>

        <div class="sectionTitle">Why AI Says ${signal.action}</div>

        <ul class="whyList">

            ${whyHtml}

        </ul>

        <div class="sectionTitle">Confidence Breakdown</div>

        ${scoreBar("Confidence", signal.confidence, 99)}

        ${scoreBar("Entry Timing", entryTimingPct, 100)}

        ${scoreBar("Market Structure", marketStructurePct, 100)}

        ${scoreBar("Risk Level", riskTierValue, 100)}

        ${scoreBar("Trend Stability", trendStabilityPct, 100)}

        ${scoreBar("Momentum Quality", momentumQualityPct, 100)}

        ${scoreBar("Buyer Dominance", buyerDominancePct, 100)}

        ${scoreBar("Breakout Probability", breakoutProbPct, 100)}

        ${scoreBar("Pattern Reliability", patternReliabilityPct, 100)}

        <div class="monitorBox">

            <div class="monitorRow">

                <span>Signal Freshness</span>

                <strong class="liveTag">${signalFreshnessText}</strong>

            </div>

            <div class="monitorRow">

                <span>Narrative Strength</span>

                <strong class="changedNo">Not available yet</strong>

            </div>

        </div>

        ${riskHtml ? `

        <div class="sectionTitle">Risks To Watch</div>

        <ul class="whyList riskList">

            ${riskHtml}

        </ul>

        ` : ""}

        ${

        isBuyTier ? `

        <div class="sectionTitle">Target (Estimated)</div>

        <div class="targetGrid">

            <div class="metricBox">

                <small>Expected Return</small>

                <strong>+${signal.target}%</strong>

            </div>

            <div class="metricBox">

                <small>Target Market Cap</small>

                <strong>$${format(signal.targetMC)}</strong>

            </div>

            <div class="metricBox tp">

                <small>Take Profit (Market Cap)</small>

                <strong>$${format(takeProfitMC)}</strong>

            </div>

            <div class="metricBox sl">

                <small>Stop Loss (Market Cap)</small>

                <strong>$${format(stopLossMC)}</strong>

            </div>

        </div>

        <div class="disclaimerNote">

            Estimates only, derived from the CRAB SCORE model - not a prediction or financial advice.

        </div>

        `

        : isHold ? `

        <div class="sectionTitle">Trade Status</div>

        <div class="monitorBox">

            <div class="monitorRow">

                <span>Recommendation</span>

                <strong class="changedNo">No Trade Recommendation</strong>

            </div>

            <div class="monitorRow">

                <span>Reason</span>

                <strong>Waiting for stronger confirmation</strong>

            </div>

            <div class="monitorRow">

                <span>Current Market Phase</span>

                <strong>Fair Valuation</strong>

            </div>

        </div>

        `

        : `

        <div class="sectionTitle">Risk Assessment</div>

        <div class="monitorBox">

            <div class="monitorRow">

                <span>Risk Level</span>

                <strong class="changedYes">${signal.risk}</strong>

            </div>

            ${avoidFlagsHtml}

        </div>

        `

        }

        <div class="sectionTitle">Market Health</div>

        <div class="healthGrid">

            <div class="metricBox">

                <small>Liquidity</small>

                <strong>$${format(signal.liquidity)}</strong>

            </div>

            <div class="metricBox">

                <small>FDV</small>

                <strong>$${format(signal.fdv)}</strong>

            </div>

            <div class="metricBox">

                <small>Market Cap</small>

                <strong>${marketCapDisplay}</strong>

            </div>

            <div class="metricBox">

                <small>Volume 24h</small>

                <strong>$${format(signal.volume)}</strong>

            </div>

            <div class="metricBox">

                <small>Trades 24h</small>

                <strong>${trades24hDisplay}</strong>

            </div>

            <div class="metricBox">

                <small>Holder</small>

                <strong>${holderDisplay}</strong>

            </div>

        </div>

        ${trades24hDisplay.includes("*") ? `

        <div class="disclaimerNote">* estimated from 1h trade rate, not a direct 24h count.</div>

        ` : ""}

        <div class="sectionTitle">Buy / Sell Pressure (24h)</div>

        ${buySellHtml}

        <div class="sectionTitle">Holder Concentration</div>

        <div class="monitorBox" id="holderConcentrationBox">

            Checking on-chain holder concentration...

        </div>

        <div class="sectionTitle">Monitoring</div>

        <div class="monitorBox">

            <div class="monitorRow">

                <span>Status</span>

                <strong class="liveTag">● LIVE</strong>

            </div>

            <div class="monitorRow">

                <span>Last Scan</span>

                <strong id="detailLastScan">Just now</strong>

            </div>

            <div class="monitorRow">

                <span>Next Scan</span>

                <strong id="detailNextScan">--s</strong>

            </div>

            <div class="monitorRow">

                <span>Recommendation Changed?</span>

                <strong class="${pair.__changed?"changedYes":"changedNo"}">

                    ${pair.__changed?"Yes":"No"}

                </strong>

            </div>

        </div>

        <div class="sectionTitle">History</div>

        <div class="historyTimeline">

            ${historyHtml}

        </div>

        <div class="sectionTitle">CRAB SCORE Breakdown</div>

        ${scoreBar("Liquidity", signal.liquidityScore,15)}

        ${scoreBar("Momentum", signal.momentumScore,20)}

        ${scoreBar("Trading", signal.ratioScore,20)}

        ${scoreBar("Valuation", signal.fdvScore,10)}

        ${scoreBar("Backing", signal.backingScore,10)}

        ${scoreBar("Holder", signal.holderScore,8)}

        ${scoreBar("Trades", signal.tradesScore,7)}

        ${scoreBar("Buy/Sell", signal.buySellScore,23)}

        <div style="
    display:flex;
    flex-direction:column;
    gap:10px;
    margin-top:20px;
">

    <button
        onclick="copyContract('${pair.baseToken.address}')">

        📋 Copy Contract

    </button>

    <button
    onclick="trackAndOpen('${dexUrl}','dexscreener_click')">

    📈 Open DexScreener

</button>

    <button
    class="gmgnBtn"
    onclick="trackAndOpen('${gmgnUrl}','gmgn_click')">

    🟢 Trade on GMGN

</button>

</div>

        `;

    },

    // =====================================
    // Called after renderDetail() HTML is
    // injected into the DOM.
    //
    // TEMPORARILY DISABLED: this used to call
    // Helius (getTokenSupply + getTokenLargestAccounts)
    // per detail-view. Disabled for now per launch
    // requirements - the section stays visible so it's
    // clear this is "off", not broken, and can be
    // re-enabled later without restructuring anything.
    // No network call is made here anymore.
    // =====================================

    async loadHolderConcentration(pair){

        const box = document.getElementById("holderConcentrationBox");

        if(!box) return;

        box.innerHTML =
            `<div class="monitorRow"><span>Top 10 Holders</span><strong class="changedNo">Temporarily disabled</strong></div>`;

    }

};

// =====================================
// SCORE BAR
// =====================================

function scoreBar(name,value,max){

    const percent = Math.min(

        (value / max) * 100,

        100

    );

    return `

    <div style="margin-bottom:14px">

        <div style="
            display:flex;
            justify-content:space-between;
            margin-bottom:6px;
            font-size:13px;
        ">

            <span>${name}</span>

            <strong>${value}/${max}</strong>

        </div>

        <div style="
            height:8px;
            background:#24213b;
            border-radius:999px;
            overflow:hidden;
        ">

            <div style="
                width:${percent}%;
                height:100%;
                background:#8b5cf6;
                border-radius:999px;
            "></div>

        </div>

    </div>

    `;

}

// =====================================
// COPY CONTRACT
// =====================================

function copyContract(address){

    navigator.clipboard.writeText(address);

    if(typeof Analytics !== "undefined"){

        Analytics.track("copy_contract");

    }

    alert("✅ Contract copied!");

}

// =====================================
// OPEN LINK + ANALYTICS
// =====================================

function trackAndOpen(url, eventName){

    if(typeof Analytics !== "undefined"){

        Analytics.track(eventName);

    }

    window.open(url, "_blank", "noopener,noreferrer");

}
