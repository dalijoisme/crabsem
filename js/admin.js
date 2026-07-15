// =====================================
// CRAB AGENT ADMIN ANALYTICS
//
// Everything here READS from the existing api.js/discovery.js/
// engine.js public surface (Discovery.load(), API.getStatus(),
// API.getDiscoveryMeta(), Engine.analyze()) - nothing about the
// discovery pipeline or CRAB SCORE formula is touched or
// re-implemented here. All numbers shown are computed live from
// real responses; nothing is a placeholder or invented.
// =====================================

const adminGate = document.getElementById("adminGate");
const adminPassword = document.getElementById("adminPassword");
const adminLoginBtn = document.getElementById("adminLoginBtn");
const adminGateError = document.getElementById("adminGateError");

const adminApp = document.getElementById("adminApp");
const adminLoading = document.getElementById("adminLoading");
const adminContent = document.getElementById("adminContent");
const adminRefreshBtn = document.getElementById("adminRefreshBtn");
const adminLiveDot = document.getElementById("adminLiveDot");
const adminLiveText = document.getElementById("adminLiveText");

// =====================================
// PASSWORD GATE (temporary client-side,
// per explicit instruction - move to a
// real backend check before this is
// treated as actual access control)
// =====================================

function attemptLogin(){

    if(adminPassword.value === CONFIG.ADMIN_PASSWORD){

        adminGate.style.display = "none";

        adminApp.classList.remove("hidden");

        runAnalyticsCycle();

    }
    else{

        adminGateError.textContent = "Incorrect password.";

    }

}

adminLoginBtn.onclick = attemptLogin;

adminPassword.addEventListener("keyup", (e)=>{

    if(e.key === "Enter") attemptLogin();

});

adminRefreshBtn.onclick = ()=> runAnalyticsCycle();

// =====================================
// SESSION LOG (real, in-memory, this
// admin session only)
// =====================================

const refreshLog = [];

// =====================================
// MAIN CYCLE
// =====================================

async function runAnalyticsCycle(){

    adminLoading.classList.remove("hidden");

    adminContent.classList.add("hidden");

    const startedAt = performance.now();

    let pairs = [];

    try{

        pairs = await Discovery.load();

    }
    catch(e){

        console.error(e);

    }

    const elapsedMs = performance.now() - startedAt;

    const analyzed = pairs.map(p=>{

        p.signal = Engine.analyze(p);

        return p;

    });

    const status = API.getStatus();

    const meta = API.getDiscoveryMeta();

    refreshLog.unshift({

        time: Date.now(),

        count: analyzed.length,

        durationMs: elapsedMs

    });

    if(refreshLog.length > 20) refreshLog.pop();

    renderAll(analyzed, status, meta);

    adminLoading.classList.add("hidden");

    adminContent.classList.remove("hidden");

}

// =====================================
// RENDER
// =====================================

function fmt(n){

    if(n==null || isNaN(n)) return "-";

    return Intl.NumberFormat("en-US",{

        notation:"compact",

        maximumFractionDigits:2

    }).format(n);

}

function avg(list){

    if(!list.length) return 0;

    return list.reduce((a,b)=>a+b,0) / list.length;

}

function barRow(label, value, max, colorClass){

    const pct = max>0 ? Math.min(100, (value/max)*100) : 0;

    return `

    <div class="adminBarRow">

        <div class="adminBarLabel"><span>${label}</span><strong>${value}</strong></div>

        <div class="adminBarTrack"><div class="adminBarFill ${colorClass||""}" style="width:${pct}%"></div></div>

    </div>

    `;

}

function renderAll(pairs, status, meta){

    // ---------- SYSTEM STATUS ----------

    const engineClass =
        status.engine==="Healthy" ? "ok" :
        status.engine==="Limited" ? "limited" : "offline";

    document.getElementById("statEngine").textContent = status.engine;

    document.getElementById("statWallet").textContent =
        (CONFIG.CRAB_MINT && CONFIG.HELIUS_RPC) ? "Configured" : "Misconfigured";

    document.getElementById("statApi").textContent = status.live;

    document.getElementById("statLastRefresh").textContent =
        meta.lastRunAt ? new Date(meta.lastRunAt).toLocaleTimeString() : "-";

    const avgResponse = avg(refreshLog.map(r=>r.durationMs));

    document.getElementById("statAvgResponse").textContent =
        avgResponse ? (avgResponse/1000).toFixed(2)+"s" : "-";

    adminLiveDot.className = "live-dot "+engineClass;

    adminLiveText.textContent = status.live;

    // ---------- DISCOVERY ----------

    document.getElementById("discObserved").textContent = fmt(meta.uniqueCandidatesObserved);

    document.getElementById("discQualified").textContent = fmt(meta.qualifiedAfterFilter);

    document.getElementById("discDisplayed").textContent = fmt(meta.displayed);

    document.getElementById("discFiltered").textContent = fmt(meta.filteredOut);

    document.getElementById("discDuration").textContent =
        meta.discoveryDurationMs!=null ? (meta.discoveryDurationMs/1000).toFixed(2)+"s" : "-";

    // ---------- DISCOVERY SOURCE ----------

    const sourceBreakdown = meta.sourceBreakdown || {};

    const maxSourceCount = Math.max(1, ...Object.values(sourceBreakdown));

    document.getElementById("sourceBreakdownBars").innerHTML =

        Object.entries(sourceBreakdown)

        .map(([name,count])=>barRow(name, count, maxSourceCount, "source"))

        .join("") || "<p class='adminNote'>No discovery data yet.</p>";

    // ---------- SIGNAL DISTRIBUTION ----------

    const signalCounts = { "STRONG BUY":0, "BUY":0, "HOLD":0, "AVOID":0 };

    pairs.forEach(p=>{

        const s = p.signal?.signal;

        if(signalCounts[s]!=null) signalCounts[s]++;

    });

    const maxSignalCount = Math.max(1, ...Object.values(signalCounts));

    const signalColors = {

        "STRONG BUY":"strongbuy",

        "BUY":"buy",

        "HOLD":"hold",

        "AVOID":"avoid"

    };

    document.getElementById("signalDistributionBars").innerHTML =

        Object.entries(signalCounts)

        .map(([name,count])=>barRow(name, count, maxSignalCount, signalColors[name]))

        .join("");

    // ---------- SCORE ANALYTICS ----------

    const scores = pairs.map(p=>p.signal?.score).filter(v=>v!=null);

    const strengths = pairs.map(p=>p.signal?.confidence).filter(v=>v!=null);

    document.getElementById("scoreAvg").textContent =
        scores.length ? Math.round(avg(scores)) : "-";

    document.getElementById("scoreStrengthAvg").textContent =
        strengths.length ? Math.round(avg(strengths))+"%" : "-";

    document.getElementById("scoreHigh").textContent =
        scores.length ? Math.max(...scores) : "-";

    document.getElementById("scoreLow").textContent =
        scores.length ? Math.min(...scores) : "-";

    // ---------- MARKET ANALYTICS ----------

    const liquidities = pairs.map(p=>p.signal?.liquidity).filter(v=>v!=null);

    const volumes = pairs.map(p=>p.signal?.volume).filter(v=>v!=null);

    const mcaps = pairs.map(p=>p.marketCap).filter(v=>v!=null && v>0);

    const fdvs = pairs.map(p=>p.signal?.fdv).filter(v=>v!=null);

    document.getElementById("mktLiquidity").textContent = "$"+fmt(avg(liquidities));

    document.getElementById("mktVolume").textContent = "$"+fmt(avg(volumes));

    document.getElementById("mktMcap").textContent = mcaps.length ? "$"+fmt(avg(mcaps)) : "N/A";

    document.getElementById("mktFdv").textContent = "$"+fmt(avg(fdvs));

    // ---------- LOG ----------

    document.getElementById("logRefreshCount").textContent = refreshLog.length;

    document.getElementById("logLastCount").textContent = pairs.length;

    let errs = 0, warns = 0;

    Object.entries(status.details || {}).forEach(([key,val])=>{

        if(key==="lastError" || key==="lastUpdated") return;

        if(val==="error") errs++;

        if(val==="partial") warns++;

    });

    document.getElementById("logErrorCount").textContent = errs;

    document.getElementById("logWarningCount").textContent = warns;

    document.getElementById("refreshHistory").innerHTML =

        refreshLog.map(r=>

            `<div class="adminLogRow"><span>${new Date(r.time).toLocaleTimeString()}</span><span>${r.count} tokens</span><span>${(r.durationMs/1000).toFixed(2)}s</span></div>`

        ).join("") || "<p class='adminNote'>No refreshes yet.</p>";

    // ---------- TOP NARRATIVES (independent
    // read-only fetch, not part of the
    // discovery pipeline) ----------

    loadTopNarratives();

}

async function loadTopNarratives(){

    const el = document.getElementById("narrativeList");

    try{

        const res = await fetch("https://api.dexscreener.com/metas/trending/v1");

        if(!res.ok) throw new Error("metas fetch failed");

        const metas = await res.json();

        if(!Array.isArray(metas) || !metas.length){

            el.innerHTML = "<p class='adminNote'>No narrative data available right now.</p>";

            return;

        }

        const top = metas

            .slice()

            .sort((a,b)=>(b.tokenCount||0)-(a.tokenCount||0))

            .slice(0,10);

        const maxCount = Math.max(1, ...top.map(m=>m.tokenCount||0));

        el.innerHTML =

            top.map(m=>

                barRow(

                    `${m.icon?.value||""} ${m.name}`.trim(),

                    m.tokenCount||0,

                    maxCount,

                    "narrative"

                )

            ).join("");

    }
    catch(e){

        console.warn("Top Narratives fetch failed", e);

        el.innerHTML = "<p class='adminNote'>Narrative data temporarily unavailable.</p>";

    }

}
