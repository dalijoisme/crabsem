// =====================================
// PRICE FORMAT (handles small meme prices)
// =====================================

// Meme-coin prices routinely sit at $0.0000001-$0.001 - showing
// scientific notation ("$8.47e-6") there is unreadable for a general
// audience, so decimal precision scales with magnitude instead:
// always enough digits to show ~3 significant figures, never
// switching to exponential notation for any price CRAB would
// realistically see.

function formatPrice(v){

    const n = Number(v || 0);

    if(n<=0) return "-";

    if(n>=1) return "$"+n.toFixed(2);

    const magnitude = Math.floor(Math.log10(n));

    const decimals = Math.min(18, Math.max(4, -magnitude + 2));

    return "$"+n.toFixed(decimals);

}

// =====================================
// LOGO (engine-quality sprint - root-cause fix)
//
// Real root cause of "logos fail" reports: renderCard() never had a
// real per-token logo URL to render in the first place - the backend
// list/trending/search query deliberately excludes the large
// raw_json blob for performance, and logo used to live nowhere else,
// so the card always fell back to the placeholder regardless of
// device. Only renderDetail() (which fetches the full row separately)
// could ever show a real logo - so "desktop works" really meant "the
// detail panel works", not "the desktop card works". The backend now
// promotes `logo` to its own flat column included in every response
// (list AND detail - see gmgnTokenRepository.js), so this ONE
// function is the single logo-loading implementation both renderCard
// and renderDetail call - same field, same fallback chain, same
// onerror handling, on every breakpoint.
// =====================================

const FALLBACK_LOGO = "images/body.png";

function resolveLogo(token){

    if(token.logo) return token.logo;

    // Backward-compatible fallback for any cached/older API response
    // that still only carries raw_json (e.g. a stale service worker
    // or CDN cache mid-rollout) - never a regression during deploy.
    try{

        const raw = token.raw_json ? JSON.parse(token.raw_json) : null;

        if(raw?.logo) return raw.logo;

    }
    catch(e){}

    return FALLBACK_LOGO;

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

        "WATCHLIST":"#94a3b8",

        "AVOID":"#ff4d4d"

    }[action] || "#ff4d4d";

}

function signalBadgeText(action){

    return {

        "STRONG BUY":"🚀 STRONG BUY",

        "BUY":"✅ BUY",

        "HOLD":"👀 HOLD",

        "WATCHLIST":"🕓 WATCHLIST",

        "AVOID":"⚠ AVOID"

    }[action] || "⚠ AVOID";

}

// =====================================
// LIFECYCLE / DATA-QUALITY (Sprint 1: data integrity)
// signal.lifecycle comes from the Intelligence Engine, derived from
// how old the token's own gmgn_tokens row is (see freshness config in
// server/src/config/scoringConfig.js). ACTIVE tokens show nothing
// extra - only WATCHLIST/ARCHIVED get a visible callout, since those
// are the cases where data integrity is actually in question.
// =====================================

// =====================================
// ENTRY TIMING (restored - see the feature audit: this existed
// before the backend rewrite, was dropped because the old heuristic
// didn't survive the move to server-side scoring, and is reimplemented
// here off `signal.stage` - a real field already computed by the
// engine from price_change_1h (server/src/services/intelligenceEngine.js
// deriveStage()), not a resurrected client-side guess.
// =====================================

function entryBadge(stage){

    if(stage !== "EARLY" && stage !== "MID" && stage !== "LATE") return "";

    return `<div class="entryBadge ${stage.toLowerCase()}">${stage}</div>`;

}

function entryMeter(stage){

    const cls = s => s===stage ? `active ${s.toLowerCase()}` : "";

    return `
        <div class="entryMeter">
            <div class="${cls("EARLY")}">EARLY</div>
            <div class="${cls("MID")}">MID</div>
            <div class="${cls("LATE")}">LATE</div>
        </div>
    `;

}

function lifecycleTag(lifecycle){

    if(lifecycle === "WATCHLIST"){

        return `<div class="lifecycleTag watchlist" title="This token dropped out of the live scan - data may be several minutes to an hour old">WATCHLIST</div>`;

    }

    if(lifecycle === "ARCHIVED"){

        return `<div class="lifecycleTag archived" title="This token's data is over an hour old - treat this recommendation as historical, not current">ARCHIVED - STALE DATA</div>`;

    }

    return "";

}

// =====================================
// RISK / ACTION CONSISTENCY (Sprint 4: engine quality)
// The action tier (from Participant Score) and the risk tier (from
// counted risk flags) are computed on independent paths - a BUY can
// legitimately coexist with HIGH risk. Rather than changing that
// scoring logic, make the conflict visible where a user would
// otherwise only see the more prominent action pill.
// =====================================

// signal.tokenStatus - the richer Trending/Inactive/Dead/Dumped/
// Completed label from server/src/services/tokenStatusService.js.

// AI Trade Plan (server/src/services/tradePlanService.js) - a real
// decision timeline (from recommendation_log, never invented) plus
// transparent, formula-driven Entry/Target/Stop bands. Market Cap is
// the primary unit (fix: this used to show Price, which is the wrong
// frame for meme coins - two tokens at the same price can have wildly
// different valuations) - price is kept as smaller secondary text.
// Split into two functions so they can be placed as two distinct
// sections (AI Trade Plan, then Decision Timeline) per the requested
// detail-panel order, right after Recommendation.

function aiTradePlanBandsHtml(tradePlan){

    const rb = tradePlan.riskBands;

    if(!rb) return `<div class="sectionTitle">AI Trade Plan</div><div class="disclaimerNote">No market cap data yet for this token - the plan will appear once it's collected.</div>`;

    // WAITING FOR CONFIRMATION (engine-quality sprint): the backend
    // deliberately withholds a numeric plan when confidence/real
    // participant coverage is too thin, or the recommendation itself
    // is AVOID (see tradePlanService.js's assessTradePlanReadiness) -
    // shown honestly with the real reasons, never replaced with a
    // guessed number.

    if(rb.status === "waiting_for_confirmation"){

        return `<div class="sectionTitle">AI Trade Plan</div><div class="disclaimerNote">Waiting for confirmation - ${(rb.reasons||[]).join(" ")}</div>`;

    }

    // Defensive shape check: catches a stale cached copy of this file
    // talking to a newer/older API (or vice versa) - the real root
    // cause behind values silently rendering as "N/A" while the
    // section title still appeared. Fails loudly and clearly instead
    // of a wall of confusing N/As, and self-heals on the very next
    // background refresh instead of staying stuck.

    const hasCompleteShape =
        rb.entryZone?.lowMc != null && rb.entryZone?.highMc != null &&
        rb.target?.marketCap != null && rb.stopLoss?.marketCap != null;

    if(!hasCompleteShape){

        console.error("AI Trade Plan: riskBands is missing expected market-cap fields - likely a stale cached copy of ui.js. Forcing a reload.", rb);

        return `<div class="sectionTitle">AI Trade Plan</div><div class="disclaimerNote">Trade plan data is out of date - <a href="javascript:location.reload(true)">tap to refresh</a>.</div>`;

    }

    return `
        <div class="sectionTitle">AI Trade Plan</div>
        <div class="tradePlanBands">
            <div>
                <span>Entry MC</span>
                <strong>${marketCapLabelValue({market_cap:rb.entryZone.lowMc})} – ${marketCapLabelValue({market_cap:rb.entryZone.highMc})}</strong>
                <small>${formatPrice(rb.entryZone.lowPrice)} – ${formatPrice(rb.entryZone.highPrice)}</small>
            </div>
            <div>
                <span>Target MC</span>
                <strong class="tpTarget">${marketCapLabelValue({market_cap:rb.target.marketCap})} (+${rb.target.expectedMovePct.toFixed(0)}%)</strong>
                <small>${formatPrice(rb.target.price)}</small>
            </div>
            <div>
                <span>Stop MC</span>
                <strong class="tpStop">${marketCapLabelValue({market_cap:rb.stopLoss.marketCap})} (-${rb.stopLoss.distancePct.toFixed(0)}%)</strong>
                <small>${formatPrice(rb.stopLoss.price)}</small>
            </div>
        </div>
        <div class="disclaimerNote">${rb.disclaimer}</div>
    `;

}

function decisionTimelineHtml(tradePlan){

    const timelineHtml = tradePlan.timeline.length ? tradePlan.timeline.map(ev => `
        <div class="tradePlanStep${ev.isLive?" isLive":""}">
            <strong style="color:${signalColor(ev.action)}">${ev.action}${ev.isLive?" · LIVE NOW":""}</strong>
            <span>${ev.isLive ? "Just now" : new Date(parseBackendTimestamp(ev.at)).toLocaleString()}</span>
            ${ev.topReason ? `<small>${ev.topReason}</small>` : ""}
        </div>
    `).join("") : `<div class="disclaimerNote">Just started watching this token - the timeline will fill in as CRAB logs real decisions over time.</div>`;

    return `
        <div class="sectionTitle">Decision Timeline</div>
        <div class="historyTimeline tradePlanTimeline">
            ${timelineHtml}
        </div>
    `;

}

function tokenStatusTag(status){

    if(!status || status === "Trending") return "";

    const cls = status.toLowerCase();

    return `<span class="tokenStatusTag ${cls}">${status}</span>`;

}

function lifecycleLabel(lifecycle){

    return {

        ACTIVE: "ACTIVE - refreshed every scheduler tick",

        WATCHLIST: "WATCHLIST - dropped out of the live scan",

        ARCHIVED: "ARCHIVED - stale, not a current signal",

        UNKNOWN: "UNKNOWN"

    }[lifecycle] || lifecycle || "UNKNOWN";

}

function freshnessAgeLabel(block){

    if(!block || !block.hasData || block.ageSeconds == null) return "Not collected yet";

    return formatDuration(block.ageSeconds * 1000);

}

function riskConflictNote(signal){

    const isBuyTier = signal.action === "STRONG BUY" || signal.action === "BUY";

    if(isBuyTier && signal.risk === "HIGH"){

        return `<div class="riskConflictNote">⚠ ${signal.action} recommendation carries HIGH risk - read the risk factors before acting</div>`;

    }

    return "";

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
// Every section below either shows real data or an honest "not
// available yet" row - never a guess, never silently omitted.
// Reuses the existing sectionTitle/monitorBox/monitorRow CSS
// classes, no new styling.
//
// Hotfix #4: "No data" read as broken/unfinished rather than as an
// honest, expected state - a whole class of tokens simply hasn't
// been through the specific real-data source a section depends on
// yet (e.g. GMGN's trenches feed only covers new launches; the
// on-demand wallet-stats cache is only populated reactively). Each
// section now explains WHY in its own terms instead of one generic
// phrase everywhere.
// =====================================

function monitorRow(label, value, cls){

    return `<div class="monitorRow"><span>${label}</span><strong${cls?` class="${cls}"`:""}>${value}</strong></div>`;

}

// Keyed by the exact section title each call site already passes in
// (see intelSection() call sites below) - one honest, specific
// reason per data source, not a single blanket phrase.

const SECTION_NO_DATA_REASON = {

    "Security": "Security check not yet run for this token",

    "Holder Distribution": "Holder breakdown not yet available",

    "Smart Money Activity": "No smart-money activity observed yet",

    "KOL Activity": "No KOL activity observed yet",

    "Trenches (Launch Status)": "Not in the new-launch feed - likely aged past that window",

    "Hot Searches": "Not currently trending in search",

    "Launchpad": "No launchpad record for this token",

    "Dev Wallet Activity": "Developer wallet not yet identified"

};

function noDataRow(title){

    const reason = SECTION_NO_DATA_REASON[title] || "Data collection in progress";

    return monitorRow("Status", reason, "changedNo");

}

function intelSection(title, hasData, bodyHtml){

    return `

    <div class="sectionTitle">${title}</div>

    <div class="monitorBox">

        ${hasData ? bodyHtml : noDataRow(title)}

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

            : monitorRow("Top 10 Concentration", "Not collected yet"),

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

            : monitorRow("Total Tokens Created", "Not collected yet")

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

        rows += monitorRow("Recent Activity", "No recent activity observed");

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

// Hotfix #4: one honest, source-specific reason per signal instead of
// a blanket "(No data)" everywhere - each of these genuinely comes
// from a different real collection path (see server/src/services/
// intelligenceEngine.js), so the explanation should match why THAT
// one is missing, not read as a generic error.

const NO_DATA_REASON_BY_KEY = {

    accumulation: "Not collected for this token",
    whale: "Not collected for this token",
    developer: "Not collected for this token",
    sniperQuality: "Not collected for this token",
    bundleQuality: "Not collected for this token",
    insiderQuality: "Not collected for this token",

    smartMoney: "Waiting for trade activity",
    kol: "Waiting for trade activity",

    walletQuality: "Insufficient wallet history",
    walletProfitability: "Insufficient wallet history",

    security: "Security check not yet run",
    holderDistribution: "Holder breakdown not yet available"

};

function breakdownGroupHtml(labels, breakdown){

    return Object.keys(labels).map(key=>{

        const cat = breakdown[key];

        const label = cat.hasData ? labels[key] : `${labels[key]} — ${NO_DATA_REASON_BY_KEY[key] || "Data collection in progress"}`;

        return scoreBar(label, cat.score, cat.max, cat.hasData);

    }).join("");

}

// `favoriteAddresses` is declared in dashboard.js (loaded after this
// file) and populated once at startup from the real backend list -
// safe to reference here because this is only ever called at render
// time, never at parse time.

function isFavorited(tokenAddress){

    return typeof favoriteAddresses !== "undefined" && favoriteAddresses.has(tokenAddress);

}

const UI = {

    // Favorites are persisted server-side, keyed by the viewer's own
    // connected wallet (see dashboard.js's `wallet`/`favoriteAddresses`
    // - loaded once at startup, updated optimistically here). `wallet`
    // and `favoriteAddresses` are declared in dashboard.js, which
    // loads after this file - safe because this only runs later, from
    // a click handler, never at parse time (same convention already
    // used for formatDuration()).

    toggleFavoriteStar(el, tokenAddress){

        if(!wallet) return;

        const nowFavorited = !el.classList.contains("active");

        el.classList.toggle("active", nowFavorited);

        el.textContent = nowFavorited ? "★" : "☆";

        if(nowFavorited){

            favoriteAddresses.add(tokenAddress);

            BackendAPI.addToFavorites(wallet, tokenAddress).catch(()=>{});

        }
        else{

            favoriteAddresses.delete(tokenAddress);

            BackendAPI.removeFromFavorites(wallet, tokenAddress).catch(()=>{});

        }

    },

    toggleWatchlistBtn(el, tokenAddress){

        if(!wallet) return;

        const nowWatching = !el.classList.contains("active");

        el.classList.toggle("active", nowWatching);

        el.textContent = nowWatching ? "✓ Watching" : "+ Watch Later";

        if(nowWatching){

            watchlistAddresses.add(tokenAddress);

            BackendAPI.addToWatchlist(wallet, tokenAddress).catch(()=>{});

        }
        else{

            watchlistAddresses.delete(tokenAddress);

            BackendAPI.removeFromWatchlist(wallet, tokenAddress).catch(()=>{});

        }

    },

    // Smart Recall - "what changed since you last looked at this",
    // computed server-side from a REAL previous view (see
    // server/src/services/userHistoryService.js) - never shown if
    // this is the viewer's first time opening the token.

    showSmartRecall(recall){

        const el = document.getElementById("smartRecallBanner");

        if(!el || !recall) return;

        const parts = [];

        if(recall.priceChangePct != null){

            const sign = recall.priceChangePct >= 0 ? "+" : "";

            parts.push(`Price ${sign}${recall.priceChangePct.toFixed(1)}%`);

        }

        if(recall.actionChanged) parts.push(`${recall.previousAction} → ${recall.currentAction}`);

        if(recall.participantScoreDelta) parts.push(`Participant Score ${recall.participantScoreDelta>0?"+":""}${recall.participantScoreDelta}`);

        if(recall.confidenceDelta) parts.push(`Confidence ${recall.confidenceDelta>0?"+":""}${recall.confidenceDelta}%`);

        if(!parts.length) return;

        el.innerHTML = `<div class="smartRecallBanner">👁 Since your last view (${formatDuration(Date.now()-parseBackendTimestamp(recall.previousViewedAt))} ago): ${parts.join(" · ")}</div>`;

    },

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

    // =====================================
    // CARD - total redesign (usability-testing sprint).
    //
    // Fixed structure, fixed height, every element always in the same
    // place: Header (rank, logo, name, timing badge, favorite) ->
    // Market Info (Vol/Liq/MCap) -> AI (Participant Score/Confidence/
    // Risk) -> Footer (the action recommendation - the single most
    // visually dominant element on the card, per the hierarchy rule:
    // Recommendation > Participant Score > Market Metrics > Badges).
    // Grid/Flex only - no absolute positioning anywhere in this
    // template, so nothing can overlap regardless of content length.
    // =====================================

    renderCard(token, rank){

        const signal = token.signal;

        const logo = resolveLogo(token);

        const medal =
            rank===1 ? "🥇" :
            rank===2 ? "🥈" :
            rank===3 ? "🥉" :
            null;

        const rankLabel =
            medal ? medal : (rank ? `#${rank}` : "");

        const changePct = token.price_change_1h;

        const changeColor = (changePct||0) >= 0 ? "#16c784" : "#ff4d4d";

        const changeLabel = (changePct!=null ? changePct.toFixed(1) : "0.0") + "%";

        const color = signalColor(signal.action);

        const symbol = token.symbol || "-";

        const name = token.name || "-";

        const fav = isFavorited(token.token_address);

        const riskClass = signal.risk === "HIGH" ? "riskHigh" : signal.risk === "MEDIUM" ? "riskMed" : "riskLow";

        // Action tier and risk tier are computed on independent paths
        // (see intelligenceEngine.js) - a BUY can legitimately carry
        // HIGH risk. Folded into the action button itself (rather than
        // a separate note) so the warning survives without needing
        // variable card height.
        const isBuyTier = signal.action === "STRONG BUY" || signal.action === "BUY";

        const riskConflict = isBuyTier && signal.risk === "HIGH";

        const actionLabel = riskConflict ? `⚠ ${signal.action} · HIGH RISK` : signalBadgeText(signal.action);

        const card=document.createElement("div");

        card.className="coinCard";

        card.innerHTML=`

        <div class="ccHeader">

            ${rankLabel ? `<span class="ccRank${medal?" medal":""}">${rankLabel}</span>` : ""}

            <img src="${logo}" class="ccLogo" alt="" onerror="this.onerror=null;this.src='images/body.png';">

            <div class="ccTitle">

                <h3 title="${symbol}">${symbol}</h3>

                <small title="${name}">${name}</small>

            </div>

            <span class="ccChange" style="color:${changeColor}">${changeLabel}</span>

            <button class="watchStar${fav?" active":""}" data-address="${token.token_address}" title="Favorite" onclick="event.stopPropagation(); UI.toggleFavoriteStar(this, '${token.token_address}')">${fav?"★":"☆"}</button>

        </div>

        <div class="ccBadgeRow">

            ${entryBadge(signal.stage)}

            ${lifecycleTag(signal.lifecycle)}

        </div>

        <div class="ccMarketInfo">

            <div><span>Vol</span><strong>$${format(token.volume_1h)}</strong></div>

            <div><span>Liq</span><strong>$${format(token.liquidity)}</strong></div>

            <div><span>MCap</span><strong>${marketCapLabelValue(token)}</strong></div>

        </div>

        <div class="ccAiInfo">

            <div class="ccScore">

                <span class="ccScoreLabel">SCORE</span>

                <strong class="ccScoreValue" style="color:${color}">${signal.participantScore}</strong>

            </div>

            <div class="ccAiMeta">

                <span>Conf <strong>${signal.confidence}%</strong></span>

                <span class="${riskClass}">Risk <strong>${signal.risk}</strong></span>

            </div>

        </div>

        <div class="ccFooter">

            <div class="ccAction${riskConflict?" ccActionWarn":""}" style="background:${color}" title="${actionLabel}">${actionLabel}</div>

            <span class="ccChain">${(token.chain||"-").toUpperCase()}</span>

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

        const logo = resolveLogo(token);

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

        // ---- Section order (usability-testing redesign): Header ->
        // Recommendation -> AI Trade Plan -> Decision Timeline ->
        // Participant Score -> Market Health -> Security -> Wallet ->
        // Raw Metrics. AI Trade Plan and Decision Timeline are the
        // primary information and sit right after Recommendation,
        // not buried at the bottom.

        const recommendationHtml = `

        <div style="display:flex; align-items:center; gap:10px; margin:14px 0 4px 0; flex-wrap:wrap;">

            <div id="detailActionBadge" style="
                display:inline-block;
                background:${color};
                color:white;
                padding:8px 18px;
                border-radius:999px;
                font-weight:700;
            ">

                ${signal.action}

            </div>

            ${tokenStatusTag(signal.tokenStatus)}

        </div>

        <div class="disclaimerNote">

            Algorithmic signal, not financial advice. CRAB is participant-first: Participant Score drives BUY/HOLD/AVOID, Market Health only confirms or adjusts confidence/risk. Computed only from real data already collected - a category with nothing collected yet says so honestly, never guessed.

        </div>

        <div id="detailStatsLine" style="font-size:12px;color:#8d90a8;margin-top:8px;">

            Stage ${signal.stage} · Participant ${signal.participantScore}/${signal.participantMax} · Market Health ${signal.marketHealth}/${signal.marketHealthMax} · Confidence <span id="detailConfidenceValue">${signal.confidence}</span>%

        </div>

        ${entryMeter(signal.stage)}

        ${riskConflictNote(signal)}

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

                <strong id="detailRiskValue" class="${signal.risk==="LOW"?"changedNo":"changedYes"}">${signal.risk}</strong>

            </div>

        </div>

        `;

        const tradePlanSectionHtml = token.tradePlan

            ? aiTradePlanBandsHtml(token.tradePlan) + decisionTimelineHtml(token.tradePlan)

            : `

            <div class="sectionTitle">AI Trade Plan</div>

            <div class="disclaimerNote">Loading real trade plan...</div>

            <div class="sectionTitle">Decision Timeline</div>

            ${justStartedWatching ? `<div class="disclaimerNote">Just started watching this token - the picture will get clearer as more data comes in.</div>` : ""}

            <div class="historyTimeline">

                ${historyHtml}

            </div>

            `;

        const participantScoreHtml = `

        <div class="sectionTitle">Participant Score</div>

        ${breakdownGroupHtml(PARTICIPANT_LABELS, signal.breakdown.participant)}

        `;

        const marketHealthHtml = `

        <div class="sectionTitle">Market Health (confirmation only)</div>

        ${breakdownGroupHtml(MARKET_LABELS, signal.breakdown.market)}

        `;

        const securitySectionHtml = renderSecuritySection(intel.security);

        const walletSectionHtml = `

        <div class="sectionTitle">Wallet</div>

        ${renderActivitySection("Smart Money Activity", intel.smartMoney)}

        ${renderActivitySection("KOL Activity", intel.kol)}

        ${renderDevWalletSection(intel.devWallet, intel.walletActivity)}

        `;

        const rawMetricsHtml = `

        <div class="sectionTitle">Raw Metrics</div>

        <div class="healthGrid">

            <div class="metricBox">

                <small>Price</small>

                <strong id="detailPriceValue">${formatPrice(token.price)}</strong>

            </div>

            <div class="metricBox">

                <small>Market Cap</small>

                <strong id="detailMarketCapValue">${marketCapLabelValue(token)}</strong>

            </div>

            <div class="metricBox">

                <small>Liquidity</small>

                <strong id="detailLiquidityValue">$${format(token.liquidity)}</strong>

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

        ${renderHolderDistributionSection(intel.holders)}

        ${renderTrenchesSection(intel.trenches)}

        ${renderHotSearchesSection(intel.hotSearches)}

        ${renderLaunchpadSection(intel.launchpad)}

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

                <span>Scheduler Last Run</span>

                <strong id="detailLastScan">Just now</strong>

            </div>

            <div class="monitorRow">

                <span>Next Scheduler Run</span>

                <strong id="detailNextScan">--s</strong>

            </div>

            <div class="monitorRow">

                <span>Token Last Updated</span>

                <strong>${updatedLabel}</strong>

            </div>

            <div class="monitorRow">

                <span>Data Lifecycle</span>

                <strong class="lifecycleLabel ${(signal.lifecycle||"unknown").toLowerCase()}">${lifecycleLabel(signal.lifecycle)}</strong>

            </div>

            <div class="monitorRow">

                <span>Market Data Age</span>

                <strong>${freshnessAgeLabel(signal.freshness?.market)}</strong>

            </div>

            <div class="monitorRow">

                <span>Security Check Age</span>

                <strong>${freshnessAgeLabel(signal.freshness?.security)}</strong>

            </div>

            <div class="monitorRow">

                <span>Smart Money Data Age</span>

                <strong>${freshnessAgeLabel(signal.freshness?.smartMoney)}</strong>

            </div>

            <div class="monitorRow">

                <span>Recommendation Changed?</span>

                <strong class="${token.__changed?"changedYes":"changedNo"}">

                    ${token.__changed?"Yes":"No"}

                </strong>

            </div>

        </div>

        `;

        return `

        <div class="detailHeader">

            <img src="${logo}" alt="" onerror="this.onerror=null;this.src='images/body.png';">

            <div class="detailHeaderInfo">

                <h2>${token.name || "-"}</h2>

                <span>${token.symbol || "-"}</span>

            </div>

            <button class="detailWatchBtn${watchlistAddresses.has(token.token_address)?" active":""}" onclick="UI.toggleWatchlistBtn(this, '${token.token_address}')">${watchlistAddresses.has(token.token_address)?"✓ Watching":"+ Watch Later"}</button>

        </div>

        <div id="smartRecallBanner"></div>

        ${recommendationHtml}

        ${tradePlanSectionHtml}

        ${participantScoreHtml}

        ${marketHealthHtml}

        ${securitySectionHtml}

        ${walletSectionHtml}

        ${rawMetricsHtml}

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

    },

    // =====================================
    // BACKGROUND DETAIL REFRESH - THE ONLY WAY the open detail panel's
    // content is ever touched while the same token stays selected (see
    // dashboard.js's showDetail() - it funnels every caller, including
    // the 30s background poll, through one guard: same token already
    // open -> call this and stop, full stop, no exceptions). Patches
    // only the specific live values via textContent/class writes -
    // NEVER innerHTML, NEVER on the panel container, NEVER a rebuilt
    // subtree. renderDetail() builds dozens of interdependent sections
    // (why-list, confirmations, security, wallet activity, decision
    // timeline) from one template string; none of that is touched here
    // by design - it stays exactly as it was when the panel was opened,
    // which is the only way to guarantee scroll position, focus, and
    // selection can never be disturbed by a routine poll.
    // =====================================

    updateDetailValues(token){

        const signal = token.signal;

        const set = (id, text) => { const el = document.getElementById(id); if(el) el.textContent = text; };

        const badge = document.getElementById("detailActionBadge");
        if(badge){
            badge.textContent = signal.action;
            badge.style.background = signalColor(signal.action);
        }

        set("detailConfidenceValue", signal.confidence);

        const riskEl = document.getElementById("detailRiskValue");
        if(riskEl){
            riskEl.textContent = signal.risk;
            riskEl.className = signal.risk === "LOW" ? "changedNo" : "changedYes";
        }

        set("detailPriceValue", formatPrice(token.price));
        set("detailMarketCapValue", marketCapLabelValue(token));
        set("detailLiquidityValue", "$" + format(token.liquidity));

    }

};

// =====================================
// SCORE BAR
// =====================================

// hasData defaults to true for any caller that doesn't pass it
// (score bars used outside the participant/market breakdown, which
// always have real data by construction). When hasData is explicitly
// false, the track MUST read as empty - showing the neutral-floor
// score as a filled bar next to a "No data" label was a real, fixed
// bug: the two statements directly contradicted each other.

function scoreBar(name,value,max,hasData=true){

    const percent = hasData ? Math.min((value / max) * 100, 100) : 0;

    return `

    <div class="scoreBarRow${hasData ? "" : " noData"}">

        <div class="scoreBarHead">

            <span>${name}</span>

            <strong>${hasData ? `${value}/${max}` : "—"}</strong>

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
