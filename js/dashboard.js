function isSessionValid(){

    const verified = sessionStorage.getItem("holderVerified") === "true";

    const disclaimerOk = sessionStorage.getItem("acceptedDisclaimer") === "true";

    const until = Number(sessionStorage.getItem("verifiedUntil") || 0);

    return verified && disclaimerOk && Date.now() < until;

}

if(!isSessionValid()){

    window.location.href="wallet.html";

}

const searchInput=document.getElementById("searchInput");
const coinGrid=document.getElementById("coinGrid");
const detailContent=document.getElementById("detailContent");
const detailPanel=document.querySelector(".detail-panel");
const closeDetailBtn=document.getElementById("closeDetailBtn");

const totalCoins=document.getElementById("totalCoins");
const signalCount=document.getElementById("signalCount");

const liveStatus=document.getElementById("liveStatus");
const liveStatusDot=document.getElementById("liveStatusDot");
const liveStatusText=document.getElementById("liveStatusText");
const engineStatusText=document.getElementById("engineStatusText");

const walletMenu=document.getElementById("walletMenu");
const walletButton=document.getElementById("walletButton");
const walletDropdown=document.getElementById("walletDropdown");
const walletAddressShort=document.getElementById("walletAddressShort");
const walletBalanceText=document.getElementById("walletBalanceText");
const walletTierText=document.getElementById("walletTierText");
const walletExplorerLink=document.getElementById("walletExplorerLink");
const walletLogoutBtn=document.getElementById("walletLogoutBtn");

const wallet=sessionStorage.getItem("walletAddress");

let timer=null;

// ======================================
// WALLET INTELLIGENCE PLATFORM - user history
// Recently Viewed / Watch Later / Favorites, persisted server-side
// (server/src/services/userHistoryService.js) keyed by this same
// connected+verified wallet - real cross-device history, not
// sessionStorage. `favoriteAddresses` is read by js/ui.js's
// isFavorited()/toggleFavoriteStar() at render/click time.
// ======================================

let favoriteAddresses = new Set();

let watchlistAddresses = new Set();

async function loadUserLists(){

    if(!wallet) return;

    try{

        const [fav, watch] = await Promise.all([

            BackendAPI.getFavorites(wallet),

            BackendAPI.getWatchlist(wallet)

        ]);

        favoriteAddresses = new Set((fav.tokens||[]).map(t=>t.token_address));

        watchlistAddresses = new Set((watch.tokens||[]).map(t=>t.token_address));

    }
    catch(err){

        console.error("Failed to load favorites/watchlist", err);

    }

}

// ======================================
// LIVE MONITORING STATE
// ======================================

const REFRESH_INTERVAL_MS = (CONFIG && CONFIG.BACKEND_REFRESH_INTERVAL) || 30000;

// The REAL scheduler clock (server-side, from GET /health's
// scheduler.lastRunAt - see server/src/services/health.js), not a
// client-side "time since my browser last fetched" clock. That
// distinction matters: the scheduler can be actively ticking every
// 30s while a specific token's own row is hours old (it fell out of
// GMGN's trending top-N) - see the data-integrity audit. This value
// answers "is the collector alive", not "is this token's data fresh"
// (that's Data Last Updated, driven by the token's own updated_at).
let schedulerLastRunAt = null;

let trendingInFlight = false;

// ======================================
// CONNECTION RETRY (backend connection UX)
// A failed load no longer just waits for the next scheduled 30s
// tick - it retries with a short, capped exponential backoff, and an
// 'online' browser event (the network actually coming back) triggers
// an immediate retry instead of waiting out the backoff.
// ======================================

let consecutiveFailures = 0;

let retryTimer = null;

const RETRY_BASE_MS = 3000;

const RETRY_MAX_MS = 24000;

function scheduleRetry(retryFn){

    clearTimeout(retryTimer);

    consecutiveFailures++;

    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, consecutiveFailures - 1));

    retryTimer = setTimeout(retryFn, delay);

    return delay;

}

function clearRetry(){

    consecutiveFailures = 0;

    clearTimeout(retryTimer);

}

window.addEventListener("online", () => {

    clearTimeout(retryTimer);

    if(searchInput.value.trim().length >= 2) loadSearch();

    else loadTrending();

});

// Recommendation history per token address (BUY/HOLD/AVOID timeline
// in the detail panel), kept in sessionStorage - same policy as
// before signals were moved server-side.

const previousAction = {};

const actionHistory = (function(){

    try{

        const raw = sessionStorage.getItem("crab_action_history");

        if(raw) return JSON.parse(raw);

    }catch(e){}

    return {};

})();

function persistActionHistory(){

    try{

        sessionStorage.setItem("crab_action_history", JSON.stringify(actionHistory));

    }catch(e){}

}

function trackRecommendationChanges(tokens){

    tokens.forEach(token=>{

        const address = token.token_address;

        if(!address) return;

        const action = token.signal.action;

        const prev = previousAction[address];

        if(!actionHistory[address]){

            actionHistory[address]=[{ action, time:Date.now() }];

            persistActionHistory();

        }
        else if(prev!==action){

            actionHistory[address].push({ action, time:Date.now() });

            if(actionHistory[address].length>6){

                actionHistory[address].shift();

            }

            persistActionHistory();

        }

        token.__changed = (prev!==undefined && prev!==action);

        token.__history = actionHistory[address];

        previousAction[address]=action;

    });

}

searchInput.focus();


// ======================================
// WALLET DROPDOWN
// (unrelated to the backend migration - unchanged)
// ======================================

function shortAddress(addr){

    if(!addr) return "--";

    return addr.substring(0,4)+"..."+addr.substring(addr.length-4);

}

function getTier(amount){

    if(amount >= 5000000) return "🦀 CRAB WHALE";

    if(amount >= 1000000) return "💎 DIAMOND CLAW";

    if(amount > 0) return "✅ VERIFIED";

    return "GUEST";

}

function renderWalletBalance(amount){

    if(walletBalanceText) walletBalanceText.innerHTML=format(amount)+" CRABSEM";

    if(walletTierText) walletTierText.innerHTML=getTier(amount);

}

async function loadWalletBalance(walletAddress){

    const cached = sessionStorage.getItem("walletBalance");

    if(cached !== null && cached !== undefined && cached !== ""){

        renderWalletBalance(Number(cached));

        return;

    }

    try{

        const response = await fetch(CONFIG.HELIUS_RPC,{

            method:"POST",

            headers:{ "Content-Type":"application/json" },

            body: JSON.stringify({

                jsonrpc:"2.0",

                id:1,

                method:"getTokenAccountsByOwner",

                params:[

                    walletAddress,

                    { mint: CONFIG.CRAB_MINT },

                    { encoding:"jsonParsed" }

                ]

            })

        });

        const data = await response.json();

        if(!data.result || data.result.value.length===0){

            renderWalletBalance(0);

            return;

        }

        const amount =
            data.result.value[0]
                .account.data.parsed.info
                .tokenAmount.uiAmount;

        sessionStorage.setItem("walletBalance", String(amount));

        renderWalletBalance(Number(amount));

    }

    catch(e){

        console.error(e);

        if(walletBalanceText) walletBalanceText.innerHTML="--";

    }

}

if(walletButton){

    if(wallet){

        walletButton.innerHTML="🦀 Holder Verified";

        if(walletAddressShort) walletAddressShort.innerHTML=shortAddress(wallet);

        if(walletExplorerLink) walletExplorerLink.href="https://solscan.io/account/"+wallet;

        loadWalletBalance(wallet);

        walletButton.onclick=(e)=>{

            e.stopPropagation();

            if(walletDropdown) walletDropdown.classList.toggle("open");

        };

        document.addEventListener("click",(e)=>{

            if(walletMenu && !walletMenu.contains(e.target)){

                if(walletDropdown) walletDropdown.classList.remove("open");

            }

        });

    }

    if(walletLogoutBtn){

        walletLogoutBtn.onclick=()=>{

            if(confirm("Logout from CRAB AGENT?")){

                sessionStorage.clear();

                window.location.href="wallet.html";

            }

        };

    }

}


// ======================================
// SEARCH
// STEP 7: 300ms debounce, fires while typing.
// ======================================

let currentSearchQuery = "";

searchInput.addEventListener("input",()=>{

    activeCustomMode = null;

    document.querySelectorAll(".modeTab").forEach(btn => btn.classList.toggle("active", btn.dataset.mode === "trending"));

    sessionStorage.setItem("crab_search_query", searchInput.value);

    clearTimeout(timer);

    timer=setTimeout(loadSearch,300);

});


// ======================================
// ENGINE / LIVE STATUS
// Real backend health (GET /api/v1/health) - never a
// hardcoded value. "Engine" here means our own backend + its
// collector/scheduler, not DexScreener's discovery pipeline.
// ======================================

async function applyStatus(){

    try{

        const health = await BackendAPI.getHealth();

        if(health.scheduler?.lastRunAt){

            schedulerLastRunAt = parseBackendTimestamp(health.scheduler.lastRunAt);

        }

        const schedulerOk = health.scheduler?.status === "active";

        const liveState =
            health.status !== "ok" ? "offline" :
            schedulerOk ? "ok" :
            "limited";

        const liveLabel =
            liveState==="ok" ? "LIVE" :
            liveState==="limited" ? "LIMITED" :
            "OFFLINE";

        const engineLabel =
            liveState==="ok" ? "Healthy" :
            liveState==="limited" ? "Warning" :
            "Offline";

        if(engineStatusText){

            engineStatusText.innerHTML = engineLabel;
            engineStatusText.className = liveState;

        }

        if(liveStatusText){

            liveStatusText.innerHTML = liveLabel;

        }

        if(liveStatusDot){

            liveStatusDot.className = "live-dot "+liveState;

        }

        if(liveStatus){

            liveStatus.className = "live-status "+liveState;

        }

    }
    catch(err){

        if(err.name === "AbortError") return;

        console.error("Health check failed", err);

        if(engineStatusText){

            engineStatusText.innerHTML = "Offline";
            engineStatusText.className = "offline";

        }

        if(liveStatusText) liveStatusText.innerHTML = "OFFLINE";

        if(liveStatusDot) liveStatusDot.className = "live-dot offline";

        if(liveStatus) liveStatus.className = "live-status offline";

    }

}


// ======================================
// LOAD TRENDING - GET /api/v1/trending
// ======================================

async function loadTrending(){

    if(trendingInFlight) return;

    trendingInFlight = true;

    try{

        setMode("trending");

        if(coinGrid.childElementCount === 0) showSkeleton();

        const result = await BackendAPI.getTrending(50);

        clearRetry();

        applyStatus();

        updateLiveMonitoring();

        renderTokens(result.tokens || []);

    }
    catch(err){

        if(err.name === "AbortError") return;

        console.error("Failed to load trending tokens", err);

        const delayMs = scheduleRetry(loadTrending);

        showLoadError(delayMs);

    }
    finally{

        trendingInFlight = false;

    }

}


// ======================================
// SEARCH - GET /api/v1/search
// ======================================

async function loadSearch(){

    const q=searchInput.value.trim();

    if(q.length<2){

        loadTrending();

        return;

    }

    if(q === currentSearchQuery) return;

    if(typeof Analytics !== "undefined"){

        Analytics.track("search");

    }

    try{

        setMode("search:"+q);

        if(coinGrid.childElementCount === 0) showSkeleton();

        const result = await BackendAPI.search(q, 50);

        currentSearchQuery = q;

        clearRetry();

        applyStatus();

        renderTokens(result.tokens || []);

    }
    catch(err){

        if(err.name === "AbortError") return;

        console.error("Search failed", err);

        const delayMs = scheduleRetry(loadSearch);

        showLoadError(delayMs);

    }

}


// ======================================
// USER HISTORY MODES (Recently Viewed / Watch Later / Favorites)
// Real, server-persisted lists (see js/backendApi.js) - not part of
// the 30s auto-refresh cycle (that's for the live trending/search
// feed only); each has its own tab and loads on demand.
// ======================================

let activeCustomMode = null;

async function loadCustomMode(customMode, fetcher){

    activeCustomMode = customMode;

    setMode(customMode);

    if(coinGrid.childElementCount === 0) showSkeleton();

    try{

        const result = await fetcher();

        renderTokens(result.tokens || []);

    }
    catch(err){

        if(err.name === "AbortError") return;

        console.error(`Failed to load ${customMode}`, err);

        showLoadError();

    }

}

function loadRecentlyViewed(){

    return loadCustomMode("recently-viewed", () => BackendAPI.getRecentlyViewed(wallet));

}

function loadWatchlistMode(){

    return loadCustomMode("watchlist", () => BackendAPI.getWatchlist(wallet));

}

function loadFavoritesMode(){

    return loadCustomMode("favorites", () => BackendAPI.getFavorites(wallet));

}

function switchMode(nextMode){

    document.querySelectorAll(".modeTab").forEach(btn => {

        btn.classList.toggle("active", btn.dataset.mode === nextMode);

    });

    if(nextMode === "trending"){

        activeCustomMode = null;

        loadTrending();

        return;

    }

    if(!wallet){

        activeCustomMode = null;

        coinGrid.innerHTML = "<h2>Connect a wallet to use Recently Viewed, Watch Later and Favorites.</h2>";

        return;

    }

    if(nextMode === "recently-viewed") loadRecentlyViewed();

    else if(nextMode === "watchlist") loadWatchlistMode();

    else if(nextMode === "favorites") loadFavoritesMode();

}


// ======================================
// RENDER - keyed reconciliation
// STEP 5: only refresh changed data, avoid unnecessary re-render.
// STEP 6: race conditions are already prevented at the network
// layer by BackendAPI (per-channel AbortController) - `mode`
// additionally guards against a stale trending response landing
// after the user has since switched to search (or vice versa).
// ======================================

let mode = "trending";

let renderedTokens = new Map(); // token_address -> { token, el }

function setMode(nextMode){

    if(nextMode === mode) return;

    mode = nextMode;

    renderedTokens = new Map();

    coinGrid.innerHTML = "";

}

function tokenFingerprint(t){

    return [
        t.price, t.market_cap, t.liquidity, t.volume_1h,
        t.holders, t.price_change_1h, t.price_change_5m, t.fdv,
        t.updated_at
    ].join("|");

}

const EMPTY_STATE_COPY = {

    "recently-viewed": "No tokens viewed yet - open a token and it'll show up here, kept even after it stops trending.",

    "watchlist": "Nothing on your Watch Later list yet - use the button on any token's detail panel to add one.",

    "favorites": "No favorites yet - tap the ☆ on any card to save it here."

};

function renderTokens(tokens){

    if(!tokens.length){

        hideSkeleton();

        coinGrid.innerHTML =
            EMPTY_STATE_COPY[mode] ? `<h2>${EMPTY_STATE_COPY[mode]}</h2>` :
            mode.startsWith("search:")
            ? "<h2>No tokens matched your search</h2>"
            : "<h2>No data yet - waiting for the next collector run</h2>";

        renderedTokens = new Map();

        totalCoins.innerHTML = 0;

        signalCount.innerHTML = 0;

        renderStatsTooltip();

        return;

    }

    trackRecommendationChanges(tokens);

    signalCount.innerHTML =

        tokens.filter(t=>

            t.signal.action==="STRONG BUY" ||

            t.signal.action==="BUY"

        ).length;

    if(renderedTokens.size === 0){

        // First render for this mode - keep the original batched,
        // animated fill-in behaviour (unchanged animation/timing).

        renderTokensIncrementally(tokens);

    }
    else{

        reconcileTokens(tokens);

    }

    totalCoins.innerHTML = tokens.length;

    renderStatsTooltip();

}


// ======================================
// INCREMENTAL / BATCH RENDERING (first render for a mode)
// Appends cards in small chunks via requestAnimationFrame -
// unchanged from the original implementation.
// ======================================

let renderToken = 0;
let sessionRestoreDone = false;

function renderTokensIncrementally(tokens){

    const myToken = ++renderToken;

    const BATCH_SIZE = 20;

    let index = 0;

    function renderNextBatch(){

        if(myToken !== renderToken) return;

        const fragment = document.createDocumentFragment();

        const end = Math.min(index + BATCH_SIZE, tokens.length);

        for(;index<end;index++){

            const rank = index+1;

            const card = UI.renderCard(tokens[index], rank);

            renderedTokens.set(tokens[index].token_address, { token: tokens[index], el: card, rank });

            fragment.appendChild(card);

        }

        coinGrid.appendChild(fragment);

        hideSkeleton();

        if(index < tokens.length){

            requestAnimationFrame(renderNextBatch);

        }
        else if(!sessionRestoreDone){

            sessionRestoreDone = true;

            restoreSessionState(tokens);

        }

    }

    requestAnimationFrame(renderNextBatch);

}


// ======================================
// RECONCILE (subsequent refreshes within the same mode)
// Unchanged tokens at their unchanged position are never touched.
// Changed tokens get their card replaced in place. New tokens are
// appended. Tokens no longer present are removed.
// ======================================

function reconcileTokens(tokens){

    const seen = new Set();

    tokens.forEach((token, i)=>{

        const rank = i+1;

        const address = token.token_address;

        seen.add(address);

        const existing = renderedTokens.get(address);

        if(!existing){

            const card = UI.renderCard(token, rank);

            coinGrid.appendChild(card);

            renderedTokens.set(address, { token, el: card, rank });

            return;

        }

        const changed =
            existing.rank !== rank ||
            tokenFingerprint(existing.token) !== tokenFingerprint(token);

        if(!changed) return;

        const card = UI.renderCard(token, rank);

        existing.el.replaceWith(card);

        renderedTokens.set(address, { token, el: card, rank });

    });

    for(const [address, entry] of renderedTokens){

        if(!seen.has(address)){

            entry.el.remove();

            renderedTokens.delete(address);

        }

    }

}


// ======================================
// SESSION STATE RESTORE
// Runs once, right after the first full render after a page
// load/refresh - restores whichever coin was open in the detail
// panel and the scroll position.
// ======================================

function restoreSessionState(tokens){

    const selectedAddress = sessionStorage.getItem("crab_selected_coin");

    if(selectedAddress){

        const match = tokens.find(t=>t.token_address === selectedAddress);

        if(match){

            showDetail(match);

        }

    }

    const savedScroll = sessionStorage.getItem("crab_scroll_y");

    if(savedScroll){

        requestAnimationFrame(()=>{

            window.scrollTo(0, Number(savedScroll));

        });

    }

}

let scrollSaveTimer = null;

window.addEventListener("scroll", ()=>{

    clearTimeout(scrollSaveTimer);

    scrollSaveTimer = setTimeout(()=>{

        sessionStorage.setItem("crab_scroll_y", String(window.scrollY));

    }, 200);

});


// ======================================
// SKELETON LOADING
// Purely visual - no data. Only shown when the grid is empty
// (first load / mode switch), never on a background refresh -
// see STEP 5, avoid unnecessary re-render.
// ======================================

const skeletonGrid = document.getElementById("skeletonGrid");

function renderSkeletonCards(count){

    if(!skeletonGrid) return;

    if(skeletonGrid.childElementCount === count) return;

    skeletonGrid.innerHTML = "";

    for(let i=0;i<count;i++){

        const el = document.createElement("div");

        el.className = "skeletonCard";

        el.innerHTML = `

            <div class="skeletonRow">

                <div class="skeletonCircle"></div>

                <div class="skeletonLines">

                    <div class="skeletonLine w60"></div>

                    <div class="skeletonLine w40"></div>

                </div>

            </div>

            <div class="skeletonLine w100"></div>

            <div class="skeletonLine w80"></div>

        `;

        skeletonGrid.appendChild(el);

    }

}

function showSkeleton(){

    renderSkeletonCards(8);

    if(skeletonGrid) skeletonGrid.style.display = "grid";

    if(coinGrid) coinGrid.style.display = "none";

}

function hideSkeleton(){

    if(skeletonGrid) skeletonGrid.style.display = "none";

    if(coinGrid) coinGrid.style.display = "grid";

}

// ======================================
// LOAD ERROR STATE
// STEP 4: never crash the UI - shown only when the grid has
// nothing to fall back on (a background refresh failure just
// leaves the last-good render in place and retries next cycle).
// ======================================

function showLoadError(delayMs){

    hideSkeleton();

    if(coinGrid.childElementCount === 0 && renderedTokens.size === 0){

        const offline = typeof navigator !== "undefined" && navigator.onLine === false;

        const retryLabel = delayMs ? `Retrying in ${Math.round(delayMs/1000)}s...` : "Retrying automatically...";

        coinGrid.innerHTML =
            offline
            ? `<h2>You appear to be offline. CRAB will reconnect automatically as soon as your connection returns.</h2>`
            : `<h2>Unable to reach the CRAB backend. ${retryLabel}</h2>`;

    }

}


// ======================================
// STATS TOOLTIP (real numbers, GET /api/v1/stats)
// Same hover-tooltip mechanism the dashboard already used for the
// discovery pipeline breakdown - now shows real database-wide
// aggregates. "Signals" itself is set directly in renderTokens()
// from real per-token signal.action values, not from this endpoint.
// ======================================

async function renderStatsTooltip(){

    const el = document.getElementById("discoverySubLabel");

    try{

        const stats = await BackendAPI.getStats();

        if(!el) return;

        el.textContent = `${stats.tokenCount} tokens tracked`;

        const lastUpdateText =
            stats.lastUpdate
            ? new Date(parseBackendTimestamp(stats.lastUpdate)).toLocaleTimeString()
            : "-";

        el.title =
            `Database stats (real, from GET /api/v1/stats):\n`+
            `Tokens tracked: ${stats.tokenCount}\n`+
            `Avg market cap: $${format(stats.avgMarketCap)}\n`+
            `Largest market cap: $${format(stats.maxMarketCap)}\n`+
            `Avg liquidity: $${format(stats.avgLiquidity)}\n`+
            `Avg holders: ${format(stats.avgHolders)}\n`+
            `Last updated: ${lastUpdateText}`;

    }
    catch(err){

        if(err.name === "AbortError") return;

        console.error("Failed to load stats", err);

    }

}


// ======================================
// DETAIL
// GET /api/v1/token/:address - the list row is shown instantly
// (loading state) while the full row (incl. raw_json, used for the
// real token logo) loads in the background.
// ======================================

let detailHistoryPushed = false;

const MOBILE_DETAIL_BREAKPOINT = 1100;

async function showDetail(token){

    detailContent.innerHTML = UI.renderDetail(token);

    detailContent.scrollTop=0;

    updateLiveMonitoring();

    UI.loadHolderConcentration(token);

    if(detailPanel){

        detailPanel.classList.add("mobileOpen");

    }

    if(window.innerWidth <= MOBILE_DETAIL_BREAKPOINT && !detailHistoryPushed){

        history.pushState({ crabDetailOpen:true }, "");

        detailHistoryPushed = true;

    }

    const address = token.token_address;

    if(address){

        sessionStorage.setItem("crab_selected_coin", address);

    }

    // Fetch the full row (adds raw_json -> real logo). If it fails
    // or is superseded by a newer click, the list-row render above
    // stays on screen - never a crash, never a blank panel.

    try{

        const full = await BackendAPI.getToken(address);

        if(sessionStorage.getItem("crab_selected_coin") !== address) return;

        detailContent.innerHTML = UI.renderDetail(full);

        detailContent.scrollTop=0;

        updateLiveMonitoring();

        UI.loadHolderConcentration(full);

        // Real per-viewer history + Smart Recall - fire-and-forget,
        // never blocks the render above (see userHistoryService.js).

        if(wallet){

            BackendAPI.recordTokenView(wallet, address)

                .then(result => {

                    if(sessionStorage.getItem("crab_selected_coin") === address && result?.smartRecall){

                        UI.showSmartRecall(result.smartRecall);

                    }

                })

                .catch(()=>{});

        }

    }
    catch(err){

        if(err.name === "AbortError") return;

        console.error("Failed to load token detail", err);

    }

}

function closeDetailOverlay(){

    if(detailPanel){

        detailPanel.classList.remove("mobileOpen");

    }

    sessionStorage.removeItem("crab_selected_coin");

}

window.addEventListener("popstate", ()=>{

    if(detailHistoryPushed){

        detailHistoryPushed = false;

        closeDetailOverlay();

    }

});

if(closeDetailBtn){

    closeDetailBtn.onclick=()=>{

        closeDetailOverlay();

        if(detailHistoryPushed){

            detailHistoryPushed = false;

            history.back();

        }

    };

}


// ======================================
// FORMAT
// ======================================

function format(v){

    if(!v) return "-";

    return Intl.NumberFormat("en-US",{

        notation:"compact",

        maximumFractionDigits:2

    }).format(v);

}


// ======================================
// LIVE MONITORING TICKER
// (UI countdown only - purely local, no network call. Actual
// refresh cadence is governed separately by REFRESH_INTERVAL_MS.)
// ======================================

function formatDuration(ms){

    const sec=Math.floor(ms/1000);

    if(sec<5){

        return "Just now";

    }

    if(sec<60){

        return sec+"s ago";

    }

    const min=Math.floor(sec/60);

    return min+"m ago";

}

function updateLiveMonitoring(){

    const lastAnalysisText=document.getElementById("lastAnalysisText");

    const nextScanText=document.getElementById("nextScanText");

    const detailLastScan=document.getElementById("detailLastScan");

    const detailNextScan=document.getElementById("detailNextScan");

    // schedulerLastRunAt is only known once GET /health has answered
    // at least once (see applyStatus) - until then, say so honestly
    // instead of showing a fake "Just now".

    if(schedulerLastRunAt == null){

        if(lastAnalysisText) lastAnalysisText.innerHTML = "Checking...";
        if(nextScanText) nextScanText.innerHTML = "";
        if(detailLastScan) detailLastScan.innerHTML = "Checking...";
        if(detailNextScan) detailNextScan.innerHTML = "--s";

        return;

    }

    const elapsed = Date.now()-schedulerLastRunAt;

    const scanLabel = formatDuration(elapsed);

    if(lastAnalysisText) lastAnalysisText.innerHTML = scanLabel;

    const remain=Math.max(

        0,

        Math.ceil((schedulerLastRunAt+REFRESH_INTERVAL_MS-Date.now())/1000)

    );

    if(nextScanText){

        nextScanText.innerHTML = remain>0 ? ("Next scan in "+remain+"s") : "Scan due now";

    }

    if(detailLastScan) detailLastScan.innerHTML = scanLabel;

    if(detailNextScan) detailNextScan.innerHTML = remain>0 ? (remain+"s") : "due now";

}


// ======================================
// INIT
// ======================================

loadUserLists();

const savedQuery = sessionStorage.getItem("crab_search_query");

if(savedQuery && savedQuery.trim().length>=2){

    searchInput.value = savedQuery;

    loadSearch();

}
else{

    loadTrending();

}


// ======================================
// TIMERS
// STEP 5: auto refresh every 30s (CONFIG.BACKEND_REFRESH_INTERVAL).
// ======================================

setInterval(updateLiveMonitoring,1000);

setInterval(()=>{

    if(activeCustomMode) return; // Recently Viewed/Watchlist/Favorites aren't time-critical - manual refresh only (re-click the tab)

    if(searchInput.value.trim().length>=2){

        loadSearch();

        return;

    }

    loadTrending();

},REFRESH_INTERVAL_MS);
