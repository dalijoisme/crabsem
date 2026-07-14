if(sessionStorage.getItem("crab_verified")!=="true"){

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

const wallet=sessionStorage.getItem("crab_wallet");

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

    const cached = sessionStorage.getItem("crab_balance");

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

        sessionStorage.setItem("crab_balance", String(amount));

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

    coinGrid.innerHTML="<h2 style='padding:20px'>Loading Market...</h2>";

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

    coinGrid.innerHTML="<h2 style='padding:20px'>Searching...</h2>";

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

        coinGrid.innerHTML="<h2>No Result</h2>";

        totalCoins.innerHTML=0;

        signalCount.innerHTML=0;

        return;

    }

    pairs=pairs.map(pair=>{

        pair.signal=Engine.analyze(pair);

        return pair;

    });

    trackRecommendationChanges(pairs);

    pairs.sort((a,b)=>b.signal.score-a.signal.score);

    totalCoins.innerHTML=pairs.length;

    signalCount.innerHTML=

    pairs.filter(

        p=>

        p.signal.signal=="HOT" ||

        p.signal.signal=="GEM"

    ).length;

    pairs.forEach(pair=>{

        const card=UI.renderCard(pair);

        coinGrid.appendChild(card);

    });

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

}

if(closeDetailBtn){

    closeDetailBtn.onclick=()=>{

        if(detailPanel){

            detailPanel.classList.remove("mobileOpen");

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

loadTrending();


// ======================================
// TIMERS
// ======================================

setInterval(updateLiveMonitoring,1000);

setInterval(()=>{

    if(searchInput.value.trim().length>=2) return;

    loadTrending();

},SCAN_INTERVAL_MS);
