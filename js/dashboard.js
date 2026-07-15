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
// LIVE MONITORING STATE
// ======================================

const SCAN_INTERVAL_MS = (CONFIG && CONFIG.SCAN_INTERVAL) || 60000;

let lastScanAt = Date.now();

let trendingInFlight = false;

// Recommendation history per token address, kept
// in-memory for this session only.

const previousAction = {};
const actionHistory = {};

searchInput.focus();


// ======================================
// WALLET DROPDOWN
// ======================================

function shortAddress(addr){

    if(!addr) return "--";

    return addr.substring(0,4)+"..."+addr.substring(addr.length-4);

}

function getTier(amount){

    if(amount >= 5000000) return "🦀 CRAB WHALE";

    if(amount >= 1000000) return "💎 DIAMOND CLAW";

    if(amount >= (CONFIG?.MIN_CRABSEM_HOLDING || 100000)) return "✅ VERIFIED";

    return "GUEST";

}

function renderWalletBalance(amount){

    if(walletBalanceText) walletBalanceText.innerHTML=format(amount)+" CRABSEM";

    if(walletTierText) walletTierText.innerHTML=getTier(amount);

}

// Reuse the balance already verified during the wallet
// flow (stored by wallet.js) instead of calling Helius
// again for the same information right after login.

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
// ======================================

searchInput.addEventListener("keyup",()=>{

    sessionStorage.setItem("crab_search_query", searchInput.value);

    clearTimeout(timer);

    timer=setTimeout(loadSearch,250);

});


// ======================================
// ENGINE / LIVE STATUS (real, from actual
// API call outcomes - no hardcoded value)
// ======================================

function applyStatus(){

    const status = API.getStatus();

    if(engineStatusText){

        engineStatusText.innerHTML = status.engine;

    }

    if(liveStatusText){

        liveStatusText.innerHTML = status.live;

    }

    const statusClass =
        status.live==="LIVE" ? "ok" :
        status.live==="LIMITED" ? "limited" :
        "offline";

    if(liveStatusDot){

        liveStatusDot.className = "live-dot "+statusClass;

    }

    if(liveStatus){

        liveStatus.className = "live-status "+statusClass;

    }

    if(engineStatusText){

        engineStatusText.className = statusClass;

    }

}


// ======================================
// LOAD TRENDING
// ======================================

async function loadTrending(){

    if(trendingInFlight) return;

    trendingInFlight = true;

    showSkeleton();

    try{

        const pairs = await Discovery.load();

        lastScanAt = Date.now();

        applyStatus();

        updateLiveMonitoring();

        renderPairs(pairs);

    }

    finally{

        trendingInFlight = false;

    }

}


// ======================================
// SEARCH
// ======================================

async function loadSearch(){

    const q=searchInput.value.trim();

    if(q.length<2){

        loadTrending();

        return;

    }

    if(typeof Analytics !== "undefined"){

        Analytics.track("search");

    }

    showSkeleton();

    const pairs=await API.search(q);

    applyStatus();

    renderPairs(pairs);

}


// ======================================
// RECOMMENDATION HISTORY TRACKING
// ======================================

function trackRecommendationChanges(pairs){

    pairs.forEach(pair=>{

        const address = pair.baseToken?.address;

        if(!address) return;

        const action = pair.signal.action;

        const prev = previousAction[address];

        if(!actionHistory[address]){

            actionHistory[address]=[{ action, time:Date.now() }];

        }

        else if(prev!==action){

            actionHistory[address].push({ action, time:Date.now() });

            if(actionHistory[address].length>6){

                actionHistory[address].shift();

            }

        }

        pair.__changed = (prev!==undefined && prev!==action);

        pair.__history = actionHistory[address];

        previousAction[address]=action;

    });

}


// ======================================
// RENDER
// ======================================

function renderPairs(pairs){

    coinGrid.innerHTML="";

    if(!pairs.length){

        hideSkeleton();

        coinGrid.innerHTML="<h2>No Result</h2>";

        totalCoins.innerHTML=0;

        signalCount.innerHTML=0;

        renderDiscoveryMeta(0);

        return;

    }

    pairs=pairs.map(pair=>{

        pair.signal=Engine.analyze(pair);

        return pair;

    });

    trackRecommendationChanges(pairs);

    const TIER_RANK = {

        "STRONG BUY":4,

        "BUY":3,

        "HOLD":2,

        "AVOID":1

    };

    pairs.sort((a,b)=>{

        const tierDiff =
            (TIER_RANK[b.signal.signal]||0) -
            (TIER_RANK[a.signal.signal]||0);

        if(tierDiff !== 0) return tierDiff;

        return b.signal.score-a.signal.score;

    });

    totalCoins.innerHTML=pairs.length;

    signalCount.innerHTML=

    pairs.filter(

        p=>

        p.signal.signal=="STRONG BUY" ||

        p.signal.signal=="BUY"

    ).length;

    renderDiscoveryMeta(pairs.length);

    renderPairsIncrementally(pairs);

}


// ======================================
// INCREMENTAL / BATCH RENDERING
// Appends cards in small chunks via
// requestAnimationFrame instead of building
// hundreds/thousands of DOM nodes in one frame -
// keeps the UI responsive as the monitored
// universe grows (Part 19: 500+/1000+/2000+).
// ======================================

let renderToken = 0;
let sessionRestoreDone = false;

function renderPairsIncrementally(pairs){

    const myToken = ++renderToken;

    const BATCH_SIZE = 20;

    let index = 0;

    function renderNextBatch(){

        if(myToken !== renderToken) return;

        const fragment = document.createDocumentFragment();

        const end = Math.min(index + BATCH_SIZE, pairs.length);

        for(;index<end;index++){

            const card = UI.renderCard(pairs[index], index+1);

            fragment.appendChild(card);

        }

        coinGrid.appendChild(fragment);

        hideSkeleton();

        if(index < pairs.length){

            requestAnimationFrame(renderNextBatch);

        }
        else if(!sessionRestoreDone){

            sessionRestoreDone = true;

            restoreSessionState(pairs);

        }

    }

    requestAnimationFrame(renderNextBatch);

}


// ======================================
// SESSION STATE RESTORE (Part 7)
// Runs once, right after the first full render after a page
// load/refresh. Restores whichever coin was open in the
// detail panel and the scroll position - so refreshing the
// page, or coming back from a window.open() DexScreener tab,
// never resets the dashboard.
// ======================================

function restoreSessionState(pairs){

    const selectedAddress = sessionStorage.getItem("crab_selected_coin");

    if(selectedAddress){

        const match = pairs.find(p=>p.baseToken?.address === selectedAddress);

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
// Shown immediately while a scan/search is in
// flight so the dashboard never shows an empty
// area (Part 10). Purely visual - no data.
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
// DISCOVERY META LABEL (real numbers only,
// from API.getDiscoveryMeta() - never a
// placeholder or a guess)
// ======================================

function renderDiscoveryMeta(shownCount){

    const el = document.getElementById("discoverySubLabel");

    if(typeof API === "undefined" || typeof API.getDiscoveryMeta !== "function"){

        return;

    }

    const meta = API.getDiscoveryMeta();

    // "Monitoring" headline number = real observed candidates
    // across all discovery sources this cycle (not the
    // filtered/shown count) - answers "how much of the market
    // is CRAB AGENT actually looking at". Falls back to the
    // shown count only if a discovery cycle hasn't completed
    // yet.

    if(totalCoins){

        totalCoins.innerHTML =
            meta.uniqueCandidatesObserved || shownCount;

    }

    if(!el) return;

    if(!meta.uniqueCandidatesObserved){

        el.textContent = "";

        return;

    }

    el.textContent =
        `Qualified ${meta.qualifiedAfterFilter} · Showing top ${shownCount}`;

    // Full pipeline breakdown as a hover tooltip - same
    // element, no layout change, but exposes every real number
    // for transparency (observed, unique, filtered out,
    // qualified, displayed, per-source breakdown, discovery
    // duration, last refresh).

    const sourceLines =
        Object.entries(meta.sourceBreakdown || {})
        .map(([name,count])=>`  ${name}: ${count}`)
        .join("\n");

    const discoveryTime =
        meta.lastRunAt
        ? new Date(meta.lastRunAt).toLocaleTimeString()
        : "-";

    const durationText =
        meta.discoveryDurationMs != null
        ? `${(meta.discoveryDurationMs/1000).toFixed(1)}s`
        : "-";

    el.title =
        `Pipeline (real data, this scan cycle):\n`+
        `Raw observed (pre-dedup): ${meta.rawObserved}\n`+
        `Unique observed: ${meta.uniqueCandidatesObserved}\n`+
        `Filtered out: ${meta.filteredOut}\n`+
        `Qualified: ${meta.qualifiedAfterFilter}\n`+
        `Displayed: ${meta.displayed}\n`+
        `Discovery duration: ${durationText}\n`+
        `Last refresh: ${discoveryTime}\n\n`+
        `Sources used:\n${sourceLines}`;

}


// ======================================
// DETAIL
// ======================================

function showDetail(pair){

    detailContent.innerHTML=

    UI.renderDetail(pair);

    detailContent.scrollTop=0;

    updateLiveMonitoring();

    UI.loadHolderConcentration(pair);

    if(detailPanel){

        detailPanel.classList.add("mobileOpen");

    }

    const address = pair.baseToken?.address;

    if(address){

        sessionStorage.setItem("crab_selected_coin", address);

    }

}

if(closeDetailBtn){

    closeDetailBtn.onclick=()=>{

        if(detailPanel){

            detailPanel.classList.remove("mobileOpen");

        }

        sessionStorage.removeItem("crab_selected_coin");

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
// (UI countdown only - purely local, no
// network call. Actual refresh cadence is
// governed separately by SCAN_INTERVAL_MS.)
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

    const elapsed = Date.now()-lastScanAt;

    if(lastAnalysisText){

        lastAnalysisText.innerHTML=formatDuration(elapsed);

    }

    const remain=Math.max(

        0,

        Math.ceil((lastScanAt+SCAN_INTERVAL_MS-Date.now())/1000)

    );

    if(nextScanText){

        nextScanText.innerHTML="Next scan in "+remain+"s";

    }

    const detailLastScan=document.getElementById("detailLastScan");

    const detailNextScan=document.getElementById("detailNextScan");

    if(detailLastScan){

        detailLastScan.innerHTML=formatDuration(elapsed);

    }

    if(detailNextScan){

        detailNextScan.innerHTML=remain+"s";

    }

}


// ======================================
// INIT
// ======================================

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
// ======================================

setInterval(updateLiveMonitoring,1000);

setInterval(()=>{

    if(searchInput.value.trim().length>=2) return;

    loadTrending();

},SCAN_INTERVAL_MS);
