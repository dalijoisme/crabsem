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
// If a real market cap isn't available,
// show N/A explicitly - never a guess.
// =====================================

function marketCapLabelValue(token){

    const raw = Number(token.market_cap || 0);

    if(raw > 0){

        return "$"+format(raw);

    }

    return "N/A";

}

// =====================================
// SIGNAL COLOR
// =====================================

function signalColor(action){

    return {

        "STRONG BUY":"#16c784",

        "BUY":"#8b5cf6",

        "HOLD":"#f5a623",

        "AVOID":"#ff4d4d"

    }[action] || "#ff4d4d";

}

function signalBadgeText(action){

    return {

        "STRONG BUY":"🚀 STRONG BUY",

        "BUY":"✅ BUY",

        "HOLD":"👀 HOLD",

        "AVOID":"⚠ AVOID"

    }[action] || "⚠ AVOID";

}

function signalBadgeClass(action){

    return {

        "STRONG BUY":"strong-buy",

        "BUY":"buy",

        "HOLD":"hold",

        "AVOID":"avoid"

    }[action] || "avoid";

}

// =====================================
// DEXSCREENER LINK
// (external chart viewer - unrelated to
// where our own data comes from)
// =====================================

function dexscreenerLink(token){

    const chainSlug =
        token.chain === "sol" ? "solana" : (token.chain || "solana");

    return `https://dexscreener.com/${chainSlug}/${token.token_address}`;

}

// =====================================
// GMGN LINK
// Referral code lives in config.js only.
// Built dynamically per token contract.
// =====================================

function gmgnLink(token){

    const code = CONFIG?.GMGN_REFERRAL_CODE || "";

    const address = token.token_address || "";

    if(!address) return "https://gmgn.ai/";

    const chainSlug = token.chain || "sol";

    return `https://gmgn.ai/${chainSlug}/token/${code}_${address}`;

}

// =====================================
// INTELLIGENCE SECTION HELPERS
// Every section below either shows real data or an honest "No data"
// row - never a guess, never silently omitted. Reuses the existing
// sectionTitle/monitorBox/monitorRow CSS classes, no new styling.
// =====================================

function monitorRow(label, value, cls){

    return `<div class="monitorRow"><span>${label}</span><strong${cls?` class="${cls}"`:""}>${value}</strong></div>`;

}

function noDataRow(){

    return monitorRow("Status", "No data", "changedNo");

}

function intelSection(title, hasData, bodyHtml){

    return `

    <div class="sectionTitle">${title}</div>

    <div class="monitorBox">

        ${hasData ? bodyHtml : noDataRow()}

    </div>

    `;

}

function yesNoUnknown(v){

    if(v === 1) return "Yes";

    if(v === 0) return "No";

    return "Unknown";

}

function renderSecuritySection(security){

    if(!security.hasData) return intelSection("Security", false);

    const rows = [

        monitorRow("Honeypot", security.isHoneypot===1 ? "⚠ Yes" : yesNoUnknown(security.isHoneypot), security.isHoneypot===1?"changedYes":"changedNo"),

        monitorRow("Mint Renounced", yesNoUnknown(security.renouncedMint)),

        monitorRow("Freeze Renounced", yesNoUnknown(security.renouncedFreezeAccount)),

        security.rugRatio!=null ? monitorRow("Rug-Risk Score", (security.rugRatio*100).toFixed(0)+"%") : "",

        monitorRow("Source", security.source)

    ].join("");

    return intelSection("Security", true, rows);

}

function renderHolderDistributionSection(holders){

    if(!holders.hasData) return intelSection("Holder Distribution", false);

    const rows = [

        monitorRow("Holder Count", format(holders.count)),

        holders.top10HolderRate!=null

            ? monitorRow("Top 10 Concentration", (holders.top10HolderRate*100).toFixed(1)+"%")

            : monitorRow("Top 10 Concentration", "No data"),

        holders.topHoldersListCached

            ? monitorRow("Detailed Holder List", `Cached ${formatDuration(Date.now()-parseBackendTimestamp(holders.topHoldersFetchedAt))}`)

            : ""

    ].join("");

    return intelSection("Holder Distribution", true, rows);

}

function renderActivitySection(title, activity){

    if(!activity.hasData) return intelSection(title, false);

    const rows = activity.activities.slice(0,5).map(a=>{

        const time = a.tx_timestamp ? new Date(a.tx_timestamp*1000).toLocaleTimeString() : "-";

        const side = a.side==="buy" ? "🟢 Buy" : "🔴 Sell";

        return monitorRow(`${side} $${format(a.amount_usd)}`, time);

    }).join("");

    return intelSection(title, true, rows);

}

function renderTrenchesSection(trenches){

    if(!trenches.hasData) return intelSection("Trenches (Launch Status)", false);

    const rows = [

        monitorRow("Section", trenches.section),

        trenches.progress!=null ? monitorRow("Bonding Progress", (trenches.progress*100).toFixed(1)+"%") : "",

        monitorRow("24h Buys / Sells", `${format(trenches.buys24h)} / ${format(trenches.sells24h)}`),

        trenches.netBuy24h!=null ? monitorRow("24h Net Buy", "$"+format(trenches.netBuy24h)) : "",

        trenches.sniperCount!=null ? monitorRow("Sniper Count", format(trenches.sniperCount)) : "",

        trenches.smartDegenCount!=null ? monitorRow("Smart-Degen Holders", format(trenches.smartDegenCount)) : ""

    ].join("");

    return intelSection("Trenches (Launch Status)", true, rows);

}

function renderHotSearchesSection(hs){

    if(!hs.hasData) return intelSection("Hot Searches", false);

    return intelSection("Hot Searches", true, monitorRow(`Rank (${hs.interval})`, "#"+hs.rank));

}

function renderLaunchpadSection(lp){

    if(!lp.hasData) return intelSection("Launchpad", false);

    const rows = [

        monitorRow("Platform", lp.platform),

        lp.totalTokensOnPlatform!=null

            ? monitorRow("Total Tokens Created", format(lp.totalTokensOnPlatform))

            : monitorRow("Total Tokens Created", "No data")

    ].join("");

    return intelSection("Launchpad", true, rows);

}

function renderDevWalletSection(devWallet, walletActivity){

    if(!devWallet.hasData) return intelSection("Dev Wallet Activity", false);

    const short = devWallet.address.slice(0,6)+"..."+devWallet.address.slice(-4);

    let rows = monitorRow("Dev Wallet", short);

    if(walletActivity.hasData && walletActivity.activities.length){

        rows += walletActivity.activities.slice(0,3).map(a=>

            monitorRow(a.event_type || "trade", a.token?.symbol || "-")

        ).join("");

    }
    else{

        rows += monitorRow("Recent Activity", "No data");

    }

    return intelSection("Dev Wallet Activity", true, rows);

}

// CRAB is participant-first: Participant Score is the primary driver
// of BUY/HOLD/AVOID, Market Health only confirms/adjusts risk and
// confidence - see server/src/config/scoringConfig.js for the full
// philosophy. Shown as two clearly separate breakdown groups so that
// distinction stays visible, not two of the same kind of bar.

const PARTICIPANT_LABELS = {

    accumulation: "Accumulation",

    smartMoney: "Smart Money",

    kol: "KOL",

    whale: "Whale",

    developer: "Developer",

    sniperQuality: "Sniper Quality",

    bundleQuality: "Bundle Quality",

    insiderQuality: "Insider Quality",

    walletQuality: "Wallet Quality",

    walletProfitability: "Wallet Profitability"

};

const MARKET_LABELS = {

    liquidity: "Liquidity",

    security: "Security",

    holderDistribution: "Holder Distribution",

    volume: "Volume",

    priceStability: "Price Stability"

};

function breakdownGroupHtml(labels, breakdown){

    return Object.keys(labels).map(key=>{

        const cat = breakdown[key];

        const label = labels[key] + (cat.hasData ? "" : " (No data)");

        return scoreBar(label, cat.score, cat.max);

    }).join("");

}

const UI = {

    // =====================================
    // CARD
    //
    // `token.signal` is computed server-side by the Intelligence
    // Engine (server/src/services/intelligenceEngine.js), which
    // gathers every real signal already collected about the token
    // across every source - market, trenches, security, smart money,
    // KOL activity. Never fabricated - a category with no real data
    // contributes a neutral score, never a guessed reason.
    // =====================================

    renderCard(token, rank){

        const signal = token.signal;

        const logo = "images/body.png";

        const medal =
            rank===1 ? "🥇" :
            rank===2 ? "🥈" :
            rank===3 ? "🥉" :
            null;

        const rankLabel =
            medal ? medal : (rank ? `#${rank}` : "");

        const changePct = token.price_change_1h;

        const changeColor = (changePct||0) >= 0 ? "#16c784" : "#ff4d4d";

        const color = signalColor(signal.action);

        const card=document.createElement("div");

        card.className="coinCard";

        card.innerHTML=`

        ${rankLabel ? `<div class="rankBadge${medal?" medal":""}">${rankLabel}</div>` : ""}

        <div class="coinHeader">

            <img src="${logo}" class="coinLogo">

            <div>

                <h3>${token.symbol || "-"}</h3>

                <small>${token.name || "-"}</small>

            </div>

            <span style="color:${changeColor}">

                ${changePct!=null ? changePct.toFixed(2) : "0.00"}%

            </span>

        </div>

        <div class="coinInfo">

            <div>

                Vol 1h

                <br>

                <strong>$${format(token.volume_1h)}</strong>

            </div>

            <div>

                Liq

                <br>

                <strong>$${format(token.liquidity)}</strong>

            </div>

            <div>

                MCap

                <br>

                <strong>${marketCapLabelValue(token)}</strong>

            </div>

        </div>

        <div class="signalBox" style="border-color:${color}">

            <small class="scoreLabel">PARTICIPANT SCORE</small>

            <h2 class="scoreValue" style="color:${color}">${signal.participantScore}</h2>

            <div class="signalPill" style="background:${color}">${signal.action}</div>

            <div class="signalMetaRow">

                <span>${signal.stage}</span>

                <span>Confidence ${signal.confidence}%</span>

                <span>Risk ${signal.risk}</span>

            </div>

        </div>

        <div class="statusBadge ${signalBadgeClass(signal.action)}">

            ${signalBadgeText(signal.action)}

        </div>

        <div class="dexBadge">

            ${(token.chain||"chain").toUpperCase()}

        </div>

        `;

        card.onclick=()=>showDetail(token);

        return card;

    },

    // =====================================
    // DETAIL PANEL
    // =====================================

    renderDetail(token){

        const signal = token.signal;

        const color = signalColor(signal.action);

        let logo = "images/body.png";

        try{

            const raw = token.raw_json ? JSON.parse(token.raw_json) : null;

            if(raw?.logo) logo = raw.logo;

        }
        catch(e){}

        const dexUrl = dexscreenerLink(token);

        const gmgnUrl = gmgnLink(token);

        if(typeof Analytics !== "undefined"){

            Analytics.track("detail_open");

        }

        const launchLabel =
            (token.launch_time && token.launch_time !== "1970-01-01 00:00:00")
            ? new Date(parseBackendTimestamp(token.launch_time)).toLocaleString()
            : "Unknown";

        const updatedLabel =
            token.updated_at
            ? formatDuration(Date.now()-parseBackendTimestamp(token.updated_at))
            : "-";

        const changeColor = (token.price_change_1h||0) >= 0 ? "#16c784" : "#ff4d4d";

        const whyHtml =
            signal.reasons.map(r=>

                `<li><span class="tick">✓</span>${r}</li>`

            ).join("");

        const riskHtml =
            signal.riskReasons.length
            ? signal.riskReasons.map(r=>

                `<li><span class="tick">✕</span>${r}</li>`

            ).join("")
            : "";

        // Confirmations are market-side observations that support or
        // weaken the participant-driven reasons above - never listed
        // as reasons themselves. "Liquidity confirms accumulation" is
        // a confirmation, not a reason CRAB is participant-first.

        const confirmHtml =
            signal.confirmations.length
            ? signal.confirmations.map(c=>

                `<li><span class="tick">≈</span>${c}</li>`

            ).join("")
            : `<li><span class="tick">≈</span>No market confirmations yet</li>`;

        const history =
            (token.__history && token.__history.length)
            ? token.__history
            : [{ action: signal.action, time: Date.now() }];

        const justStartedWatching = history.length <= 1;

        const historyHtml =
            history.map((h,i)=>{

                const isCurrent = i===history.length-1;

                const timeLabel = new Date(h.time).toLocaleTimeString();

                return `

                <div class="historyStep ${isCurrent?"current":""}">

                    <strong>${h.action}</strong>

                    <span>${timeLabel}</span>

                </div>

                `;

            }).join("");

        const intel = signal.intelligence;

        return `

        <div class="detailHeader">

            <img src="${logo}" width="64" style="border-radius:50%">

            <div class="detailHeaderInfo">

                <h2>${token.name || "-"}</h2>

                <span>${token.symbol || "-"}</span>

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

            Algorithmic signal, not financial advice. CRAB is participant-first: Participant Score drives BUY/HOLD/AVOID, Market Health only confirms or adjusts confidence/risk. Computed only from real data already collected - a category with nothing collected yet is shown as "No data", never guessed.

        </div>

        <div style="font-size:12px;color:#8d90a8;margin-top:8px;">

            Stage ${signal.stage} · Participant ${signal.participantScore}/${signal.participantMax} · Market Health ${signal.marketHealth}/${signal.marketHealthMax} · Confidence ${signal.confidence}%

        </div>

        <div class="sectionTitle">Why ${signal.action}</div>

        <ul class="whyList">

            ${whyHtml}

        </ul>

        <div class="sectionTitle">Market Confirmations</div>

        <ul class="whyList">

            ${confirmHtml}

        </ul>

        ${riskHtml ? `

        <div class="sectionTitle">Risks To Watch</div>

        <ul class="whyList riskList">

            ${riskHtml}

        </ul>

        ` : ""}

        <div class="sectionTitle">Risk Level</div>

        <div class="monitorBox">

            <div class="monitorRow">

                <span>Risk</span>

                <strong class="${signal.risk==="LOW"?"changedNo":"changedYes"}">${signal.risk}</strong>

            </div>

        </div>

        <div class="sectionTitle">Participant Score Breakdown (primary)</div>

        ${breakdownGroupHtml(PARTICIPANT_LABELS, signal.breakdown.participant)}

        <div class="sectionTitle">Market Health Breakdown (confirmation only)</div>

        ${breakdownGroupHtml(MARKET_LABELS, signal.breakdown.market)}

        <div class="sectionTitle">Market Data</div>

        <div class="healthGrid">

            <div class="metricBox">

                <small>Price</small>

                <strong>${formatPrice(token.price)}</strong>

            </div>

            <div class="metricBox">

                <small>Market Cap</small>

                <strong>${marketCapLabelValue(token)}</strong>

            </div>

            <div class="metricBox">

                <small>Liquidity</small>

                <strong>$${format(token.liquidity)}</strong>

            </div>

            <div class="metricBox">

                <small>FDV</small>

                <strong>$${format(token.fdv)}</strong>

            </div>

            <div class="metricBox">

                <small>Volume 1h</small>

                <strong>$${format(token.volume_1h)}</strong>

            </div>

            <div class="metricBox">

                <small>Price Change 1h</small>

                <strong style="color:${changeColor}">${token.price_change_1h!=null ? token.price_change_1h.toFixed(2) : "0.00"}%</strong>

            </div>

            <div class="metricBox">

                <small>Holders</small>

                <strong>${token.holders!=null ? format(token.holders) : "-"}</strong>

            </div>

            <div class="metricBox">

                <small>Launched</small>

                <strong>${launchLabel}</strong>

            </div>

        </div>

        ${renderSecuritySection(intel.security)}

        ${renderHolderDistributionSection(intel.holders)}

        ${renderActivitySection("Smart Money Activity", intel.smartMoney)}

        ${renderActivitySection("KOL Activity", intel.kol)}

        ${renderTrenchesSection(intel.trenches)}

        ${renderHotSearchesSection(intel.hotSearches)}

        ${renderLaunchpadSection(intel.launchpad)}

        ${renderDevWalletSection(intel.devWallet, intel.walletActivity)}

        <div class="sectionTitle">Holder Concentration (Live)</div>

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

                <span>Data Last Updated</span>

                <strong>${updatedLabel}</strong>

            </div>

            <div class="monitorRow">

                <span>Recommendation Changed?</span>

                <strong class="${token.__changed?"changedYes":"changedNo"}">

                    ${token.__changed?"Yes":"No"}

                </strong>

            </div>

        </div>

        <div class="sectionTitle">History</div>

        ${justStartedWatching ? `<div class="disclaimerNote">Just started watching this token - the picture will get clearer as more data comes in.</div>` : ""}

        <div class="historyTimeline">

            ${historyHtml}

        </div>

        <div class="detailActions" style="
    display:flex;
    flex-direction:column;
    gap:10px;
    margin-top:20px;
">

    <button
        onclick="copyContract('${token.token_address}')">

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

${(typeof WalletDetect !== "undefined" && WalletDetect.isInWalletBrowser && WalletDetect.isInWalletBrowser()) ? `

<div class="disclaimerNote walletBrowserHint">💡 You're inside ${WalletDetect.inAppBrowserName()}'s built-in browser. After opening DexScreener, use its tab switcher (not the Back button) to return to CRAB AGENT.</div>

` : ""}

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
    // No network call is made here anymore. (Distinct from
    // "Holder Distribution" above, which is real - this is
    // specifically the live on-chain concentration check.)
    // =====================================

    async loadHolderConcentration(token){

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

    <div class="scoreBarRow">

        <div class="scoreBarHead">

            <span>${name}</span>

            <strong>${value}/${max}</strong>

        </div>

        <div class="scoreBarTrack">

            <div class="scoreBarFill" style="width:${percent}%"></div>

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

    // Temuan 11 (mobile testing): inside wallet in-app browsers
    // (Phantom etc.), window.open() often navigates the SAME
    // WebView instead of opening a real new tab - so the phone's
    // Back button then lands on the wallet's home screen, not
    // back in CRAB AGENT. A real anchor element with
    // target=_blank is treated as a genuine new-tab intent by
    // more WebViews than the JS API is, so we synthesize one.
    // This is a best-effort improvement - Phantom's WebView
    // behaviour is ultimately theirs, which is why there is ALSO
    // a visible hint for users in that environment (see
    // renderDetail external-link section).

    const a = document.createElement("a");

    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    document.body.appendChild(a);

    a.click();

    a.remove();

}
