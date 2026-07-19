// =====================================
// CRAB AGENT ADMIN PANEL (engine-quality sprint - full rewrite)
//
// The previous version of this file drove a page built on the OLD
// client-side discovery pipeline (Discovery.load()/Engine.analyze()/
// API.getStatus() from js/api.js/discovery.js/engine.js) - a
// completely different, now-orphaned system that predates the
// current Node/SQLite backend entirely. Its password gate was also
// already broken (compared against CONFIG.ADMIN_PASSWORD_HASH, a key
// config.js never actually defines). This rewrite talks ONLY to the
// real backend (js/backendApi.js's BACKEND_API_URL) and gates access
// with a real server-side check (server/src/middleware/adminAuth.js) -
// the password is sent as the X-Admin-Key header and verified
// server-side on every request, not compared client-side.
// =====================================

const BASE_URL = (typeof CONFIG !== "undefined" && CONFIG.BACKEND_API_URL) || "http://localhost:4000/api/v1";

const ADMIN_KEY_STORAGE = "crab_admin_key";

const adminGate = document.getElementById("adminGate");
const adminPasswordInput = document.getElementById("adminPassword");
const adminLoginBtn = document.getElementById("adminLoginBtn");
const adminGateError = document.getElementById("adminGateError");

const adminApp = document.getElementById("adminApp");
const adminLoading = document.getElementById("adminLoading");
const adminContent = document.getElementById("adminContent");
const adminRefreshBtn = document.getElementById("adminRefreshBtn");
const adminLogoutBtn = document.getElementById("adminLogoutBtn");
const adminLiveDot = document.getElementById("adminLiveDot");
const adminLiveText = document.getElementById("adminLiveText");

// =====================================
// FETCH HELPERS
// =====================================

function getAdminKey(){

    return sessionStorage.getItem(ADMIN_KEY_STORAGE) || "";

}

async function adminFetch(path, options = {}){

    const res = await fetch(`${BASE_URL}${path}`, {

        ...options,

        headers: { ...(options.headers || {}), "X-Admin-Key": getAdminKey() }

    });

    const json = await res.json().catch(() => null);

    if(res.status === 401){

        sessionStorage.removeItem(ADMIN_KEY_STORAGE);

        showGate("Session expired or incorrect password - please log in again.");

        throw new Error("Unauthorized");

    }

    if(!json || !json.success) throw new Error(json?.error || `Request failed (HTTP ${res.status})`);

    return json.data;

}

// Public (unauthenticated) endpoints - token search, wallet profile,
// wallet leaderboard/search - the same real endpoints
// dashboard.html/wallet pages already use.

async function publicFetch(path){

    const res = await fetch(`${BASE_URL}${path}`);

    const json = await res.json().catch(() => null);

    if(!json || !json.success) throw new Error(json?.error || `Request failed (HTTP ${res.status})`);

    return json.data;

}

// =====================================
// SECTION ISOLATION (Admin V3.1, Parts 1-3) - the root cause of
// "several metrics that worked before V3 are now empty": every load
// cycle used to run several fetches inside ONE Promise.all(), then
// called every render function in the SAME try block. If any single
// fetch in that batch failed (a not-yet-deployed backend route, a
// transient error, anything) the whole batch's catch fired and NONE
// of that batch's renders ran - wiping out sections that had nothing
// to do with the failing endpoint. loadOne() below fetches+renders
// exactly one section and NEVER throws past itself - one bad section
// can no longer take any other section down with it, and a failed
// section shows a real "No data available" note instead of staying
// blank or surfacing a raw error string.
// =====================================

async function loadOne(promise, renderFn, fallbackFn){

    try{

        const data = await promise;

        renderFn(data);

        return data;

    }
    catch(e){

        console.error("Admin section load failed:", e);

        try{ fallbackFn(); } catch(e2){ console.error("Admin fallback render failed:", e2); }

        return null;

    }

}

function setElsText(ids, text){

    ids.forEach(id => { const el = document.getElementById(id); if(el) el.textContent = text; });

}

function noData(containerId, message = "No data available."){

    const el = document.getElementById(containerId);

    if(el) el.innerHTML = `<p class="adminNote">${message}</p>`;

}

// =====================================
// GATE
// =====================================

function showGate(message){

    adminGate.style.display = "flex";

    adminApp.classList.add("hidden");

    if(message) adminGateError.textContent = message;

}

// Real login flow (login-then-token sprint): POST /admin/login with
// the entered password -> the backend checks it against
// process.env.ADMIN_PASSWORD once and hands back a session token
// (see services/adminAuthService.js) -> that token is what's stored
// and sent as X-Admin-Key on every subsequent /admin/* call. The raw
// password itself is never stored or resent after this one request.

async function attemptLogin(){

    const entered = adminPasswordInput.value;

    if(!entered) return;

    adminGateError.textContent = "";

    adminLoginBtn.disabled = true;

    try{

        const res = await fetch(`${BASE_URL}/admin/login`, {

            method: "POST",

            headers: { "Content-Type": "application/json" },

            body: JSON.stringify({ password: entered })

        });

        const json = await res.json().catch(() => null);

        if(res.status === 401){

            adminGateError.textContent = "Incorrect password.";

            return;

        }

        if(res.status === 503){

            adminGateError.textContent = "Admin panel is not configured on the backend (ADMIN_PASSWORD unset).";

            return;

        }

        if(!res.ok || !json?.success || !json.data?.token){

            adminGateError.textContent = `Unexpected error (HTTP ${res.status}).`;

            return;

        }

        sessionStorage.setItem(ADMIN_KEY_STORAGE, json.data.token);

        adminGate.style.display = "none";

        adminApp.classList.remove("hidden");

        adminPasswordInput.value = "";

        loadAll();

    }
    catch(e){

        adminGateError.textContent = "Could not reach the backend - check your connection.";

    }
    finally{

        adminLoginBtn.disabled = false;

    }

}

adminLoginBtn.onclick = attemptLogin;

adminPasswordInput.addEventListener("keyup", (e) => { if(e.key === "Enter") attemptLogin(); });

adminLogoutBtn.onclick = () => {

    sessionStorage.removeItem(ADMIN_KEY_STORAGE);

    showGate("");

};

adminRefreshBtn.onclick = () => loadAll();

// Auto-resume a session already unlocked earlier this tab.

(function tryAutoResume(){

    if(getAdminKey()){

        adminGate.style.display = "none";

        adminApp.classList.remove("hidden");

        loadAll();

    }

})();

// =====================================
// FORMAT HELPERS
// =====================================

function fmtUsd(n){

    if(n == null || isNaN(n)) return "-";

    return "$" + Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);

}

function fmtNum(n, digits = 0){

    if(n == null || isNaN(n)) return "-";

    return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });

}

function fmtPct(n, digits = 1){

    if(n == null || isNaN(n)) return "-";

    return (Number(n) * 100).toFixed(digits) + "%";

}

function fmtDuration(seconds){

    if(seconds == null || isNaN(seconds)) return "-";

    if(seconds < 60) return `${Math.round(seconds)}s`;

    if(seconds < 3600) return `${Math.round(seconds/60)}m`;

    return `${(seconds/3600).toFixed(1)}h`;

}

// =====================================
// ADMIN DATE FILTER (UX sprint, Part 2) - applies to Prediction
// Validation summary/strong-buy/statistics AND Wallet Rankings/ROI in
// Analytics. `from`/`to` are real "YYYY-MM-DD" strings the backend
// compares against real timestamps (prediction_time / last_seen) -
// undefined means "All Time", never a fabricated default range.
// =====================================

let predictionDateFilter = { from: undefined, to: undefined };

function toDateStr(d){

    return d.toISOString().slice(0, 10);

}

function daysAgoUTC(n){

    const d = new Date();

    d.setUTCHours(0, 0, 0, 0);

    d.setUTCDate(d.getUTCDate() - n);

    return d;

}

function computeQuickRange(key){

    const today = daysAgoUTC(0);

    if(key === "today") return { from: toDateStr(today), to: toDateStr(today) };

    if(key === "yesterday"){ const y = daysAgoUTC(1); return { from: toDateStr(y), to: toDateStr(y) }; }

    if(key === "7d") return { from: toDateStr(daysAgoUTC(6)), to: toDateStr(today) };

    if(key === "30d") return { from: toDateStr(daysAgoUTC(29)), to: toDateStr(today) };

    if(key === "month"){

        const first = new Date(); first.setUTCHours(0,0,0,0); first.setUTCDate(1);

        return { from: toDateStr(first), to: toDateStr(today) };

    }

    return { from: undefined, to: undefined }; // "all"

}

// Builds a "?a=b&c=d" query string merging any endpoint-specific
// params with the current date filter - the one place any admin.js
// call site adds from/to, so no fetch can accidentally forget it.

function buildFilterParams(extra = {}){

    const params = new URLSearchParams(extra);

    if(predictionDateFilter.from) params.set("from", predictionDateFilter.from);

    if(predictionDateFilter.to) params.set("to", predictionDateFilter.to);

    const qs = params.toString();

    return qs ? `?${qs}` : "";

}

function updateActiveFilterLabel(){

    const label = document.getElementById("predFilterActiveLabel");

    if(!label) return;

    label.textContent = (predictionDateFilter.from || predictionDateFilter.to)

        ? `Showing: ${predictionDateFilter.from || "…"} to ${predictionDateFilter.to || "…"}`

        : "Showing: All Time";

}

function dexscreenerLink(address){

    return `https://dexscreener.com/solana/${address}`;

}

function gmgnLink(address){

    const code = (typeof CONFIG !== "undefined" && CONFIG.GMGN_REFERRAL_CODE) || "";

    return `https://gmgn.ai/sol/token/${code}_${address}`;

}

// Wallet-address explorer links (Admin V3.1/Product Sprint, Part 3) -
// distinct from gmgnLink() above, which is a TOKEN page URL. GMGN's
// real wallet-profile URL uses /sol/address/ instead of /sol/token/.

function solscanWalletLink(address){

    return `https://solscan.io/account/${address}`;

}

function birdeyeWalletLink(address){

    return `https://birdeye.so/profile/${address}?chain=solana`;

}

function gmgnWalletLink(address){

    const code = (typeof CONFIG !== "undefined" && CONFIG.GMGN_REFERRAL_CODE) || "";

    return `https://gmgn.ai/sol/address/${code}_${address}`;

}

// =====================================
// MAIN LOAD CYCLE
// =====================================

// ROOT CAUSE FIX (UX sprint): every previous call to loadAll() -
// whether the manual "Refresh Now" click or (once Part 2's filter
// controls exist) a filter change - hid the ENTIRE adminContent block
// and showed the full-page loading message, every single time. That
// collapses the page to a few lines of text and back, which is
// exactly the kind of full-DOM-teardown that forces the browser to
// reset scroll position - the admin.html half of this sprint's
// reported bug. The loading screen now only appears on the very
// first load (nothing to preserve yet); every refresh after that
// updates the already-visible sections in place, with scrollY
// captured/restored around it as a defensive safeguard, the same
// pattern used in js/dashboard.js's reconcileTokens() fix.

let adminFirstLoadDone = false;

const DASHBOARD_STAT_IDS = ["dashEngineStatus","dashScheduler","dashDatabase","dashStrongBuyCount","dashTotalGenerated","dashValidated","dashPending","dashWinRate","dashTpCount","dashSlCount","dashOpenCount","dashCorrectHold","dashMissedOpportunity","dashCorrectHoldRate","dashAvoidEvaluation"];

const AI_HEALTH_STAT_IDS = ["aiHealthTodayAccuracy","aiHealthSevenDayTrend","aiHealthConfidence","aiHealthAvgRoi","aiHealthBestCategory","aiHealthWorstCategory","aiHealthTimeToTp","aiHealthTimeToSl"];

const SYSTEM_STAT_IDS = ["sysEngineStatus","sysScheduler","sysUptime","sysDb","sysDbSize","sysMigration","sysTokenCount","sysLastScan","sysNextScan"];

async function loadAll(){

    const isFirstLoad = !adminFirstLoadDone;

    if(isFirstLoad){

        adminLoading.classList.remove("hidden");

        adminContent.classList.add("hidden");

    }

    const scrollY = window.scrollY;

    // Each section below is fully isolated (Parts 1-3): its own fetch,
    // its own render, its own fallback - a failure in one can never
    // blank, hide, or throw out of the others.

    const [dashboard, system, wallets, engineConfig, predictions, engineStatus, engineHistory] = await Promise.all([

        loadOne(adminFetch("/admin/dashboard"), renderDashboard, () => setElsText(DASHBOARD_STAT_IDS, "N/A")),

        loadOne(adminFetch("/admin/system"), renderSystem, () => setElsText(SYSTEM_STAT_IDS, "N/A")),

        loadOne(adminFetch("/admin/wallets/summary"), renderWallets, () => { setElsText(["walTotal"], "N/A"); noData("walletLabelBars"); }),

        loadOne(adminFetch("/admin/engine/config"), renderEngineConfig, () => noData("engineConfigTables")),

        loadOne(adminFetch("/admin/predictions/summary"), renderPredictions, () => noData("predictionSummary")),

        loadOne(adminFetch("/admin/ceo/engine-status"), renderEngineStatus, () => { setElsText(["dashEngineVersion"], "N/A"); noData("ceoStatusRow"); }),

        loadOne(adminFetch("/admin/ceo/engine-history"), d => renderEngineHistory(d.history), () => noData("ceoEngineHistory")),

        loadOne(adminFetch("/admin/learn/summary"), renderLearnSummary, () => { noData("learnSummary"); noData("learnHistory"); })

    ]);

    await loadPredictionAndAnalytics();

    if(system){

        adminLiveDot.className = "live-dot " + (system.engineStatus === "ok" ? "ok" : "limited");

        adminLiveText.textContent = system.engineStatus === "ok" ? "LIVE" : "LIMITED";

    }
    else{

        adminLiveDot.className = "live-dot limited";

        adminLiveText.textContent = "UNKNOWN";

    }

    adminFirstLoadDone = true;

    adminLoading.classList.add("hidden");

    adminContent.classList.remove("hidden");

    if(window.scrollY !== scrollY) window.scrollTo(0, scrollY);

}

// =====================================
// DASHBOARD (the minimal login-landing cards this sprint asked for)
// =====================================

function renderDashboard(d){

    document.getElementById("dashEngineStatus").textContent = d.engineStatus.toUpperCase();

    document.getElementById("dashScheduler").textContent = d.scheduler.gmgn.status.toUpperCase();

    document.getElementById("dashDatabase").textContent = d.database.connected ? "Connected" : "Disconnected";

    document.getElementById("dashStrongBuyCount").textContent = fmtNum(d.strongBuyCount);

    // Product Refinement Sprint, Part 1/4 - ALL-TIER totals (never
    // affected by the date filter above), clearly separate from
    // "Trading Performance" below.

    document.getElementById("dashTotalGenerated").textContent = fmtNum(d.totalPredictionsGenerated);

    document.getElementById("dashValidated").textContent = fmtNum(d.validatedPredictions);

    document.getElementById("dashPending").textContent = fmtNum(d.pendingValidation);

    // Trading Performance - BUY + STRONG BUY only (Part 2, HIGHEST
    // PRIORITY). getSummary() on the backend is now always scoped this
    // way - HOLD/AVOID can never appear in these four numbers.

    const v = d.tradingPerformance;

    document.getElementById("dashWinRate").textContent = v.winRate != null ? fmtPct(v.winRate) : "n/a";

    document.getElementById("dashTpCount").textContent = fmtNum(v.tpCount);

    document.getElementById("dashSlCount").textContent = fmtNum(v.slCount);

    document.getElementById("dashOpenCount").textContent = fmtNum(v.openCount);

    // HOLD & AVOID Evaluation (Part 3) - HOLD gets a real evaluation of
    // its own; AVOID is honestly disclosed as not evaluable this way.

    const hae = d.holdAvoidEvaluation;

    document.getElementById("dashCorrectHold").textContent = fmtNum(hae.hold.correctHoldCount);

    document.getElementById("dashMissedOpportunity").textContent = fmtNum(hae.hold.missedOpportunityCount);

    document.getElementById("dashCorrectHoldRate").textContent = hae.hold.correctHoldRate != null ? fmtPct(hae.hold.correctHoldRate) : "n/a";

    document.getElementById("dashAvoidEvaluation").textContent = hae.avoid.evaluable ? "Evaluable" : "Not evaluable";

    const reasonsEl = document.getElementById("dashMissedOpportunityReasons");

    const avoidNote = !hae.avoid.evaluable ? `<p class="adminNote">${hae.avoid.reason}</p>` : "";

    if(hae.hold.missedOpportunityReasons.length){

        const max = Math.max(1, ...hae.hold.missedOpportunityReasons.map(r => r.count));

        reasonsEl.innerHTML = avoidNote + `<p class="adminNote">Most common reasons a HOLD signal turned out to be a Missed Opportunity:</p>` +
            hae.hold.missedOpportunityReasons.slice(0, 8).map(r => barRowCeo(r.reason, r.count, max)).join("");

    }
    else{

        reasonsEl.innerHTML = avoidNote + `<p class="adminNote">No missed-opportunity reasons recorded yet.</p>`;

    }

}

// AI HEALTH (Product Improvement Sprint, Part 5/8) - "how healthy is
// my AI, is it improving, what should I improve today", above the
// fold. Fed by GET /admin/ceo/ai-health.

function renderAiHealth(d){

    document.getElementById("aiHealthTodayAccuracy").textContent = d.todaysAccuracy != null ? `${fmtPct(d.todaysAccuracy)} (n=${fmtNum(d.todaysPredictionCount)})` : "n/a today";

    const trend = d.sevenDayTrend;

    document.getElementById("aiHealthSevenDayTrend").textContent = trend.available
        ? `${trend.delta != null ? (trend.delta > 0 ? "+" : "") + (trend.delta*100).toFixed(1) + "pp" : "n/a"}`
        : "Not enough history yet";

    document.getElementById("aiHealthConfidence").textContent = d.confidenceHealth.status;

    document.getElementById("aiHealthAvgRoi").textContent = d.averageRoiPct != null ? d.averageRoiPct.toFixed(1) + "%" : "-";

    document.getElementById("aiHealthBestCategory").textContent = d.bestPerformingCategory ? `${d.bestPerformingCategory.key} (${fmtPct(d.bestPerformingCategory.winRate)})` : "Not enough sample yet";

    document.getElementById("aiHealthWorstCategory").textContent = d.worstPerformingCategory ? `${d.worstPerformingCategory.key} (${fmtPct(d.worstPerformingCategory.winRate)})` : "Not enough sample yet";

    document.getElementById("aiHealthTimeToTp").textContent = fmtDuration(d.averageTimeToTpSeconds);

    document.getElementById("aiHealthTimeToSl").textContent = fmtDuration(d.averageTimeToSlSeconds);

}

// =====================================
// SYSTEM
// =====================================

function renderSystem(s){

    document.getElementById("sysEngineStatus").textContent = s.engineStatus.toUpperCase();

    document.getElementById("sysScheduler").textContent = s.scheduler.gmgn.status.toUpperCase();

    document.getElementById("sysUptime").textContent = fmtDuration(s.uptimeSeconds);

    document.getElementById("sysDb").textContent = s.database.connected ? "Connected" : "Disconnected";

    document.getElementById("sysDbSize").textContent = s.database.sizeBytes != null ? fmtUsd(s.database.sizeBytes).replace("$","") + " B" : "-";

    document.getElementById("sysMigration").textContent = `#${s.migration.appliedCount} (${s.migration.latestFile || "-"})`;

    document.getElementById("sysTokenCount").textContent = fmtNum(s.database.tokenCount);

    document.getElementById("sysLastScan").textContent = s.scheduler.gmgn.lastRunAt ? `${s.scheduler.gmgn.secondsSinceLastRun}s ago` : "Never";

    document.getElementById("sysNextScan").textContent = s.scheduler.gmgn.nextRunEtaSeconds != null ? `~${s.scheduler.gmgn.nextRunEtaSeconds}s` : "-";

}

// =====================================
// WALLET
// =====================================

function barRow(label, value, max, colorClass){

    const pct = max > 0 ? Math.min(100, (value/max)*100) : 0;

    return `
        <div class="adminBarRow">
            <div class="adminBarLabel"><span>${label}</span><strong>${value}</strong></div>
            <div class="adminBarTrack"><div class="adminBarFill ${colorClass||""}" style="width:${pct}%"></div></div>
        </div>
    `;

}

function renderWallets(w){

    document.getElementById("walTotal").textContent = fmtNum(w.totalWallets);

    const maxCount = Math.max(1, ...w.byLabel.map(l => l.count));

    document.getElementById("walletLabelBars").innerHTML =

        w.byLabel.map(l => barRow(l.label, l.count, maxCount)).join("");

}

document.getElementById("walletSearchBtn").onclick = async () => {

    const address = document.getElementById("walletSearchInput").value.trim();

    const resultEl = document.getElementById("walletSearchResult");

    if(!address){ resultEl.innerHTML = ""; return; }

    resultEl.innerHTML = `<p class="adminNote">Searching...</p>`;

    try{

        const profile = await publicFetch(`/wallets/${encodeURIComponent(address)}`);

        const wallet = profile.wallet;

        resultEl.innerHTML = `
            <div class="adminTokenRow">
                <div class="adminTokenRowHead">
                    <strong>${wallet.wallet_address}</strong>
                    <span class="adminPill">${wallet.primary_label || "Unlabeled"}</span>
                </div>
                <div class="adminGrid4">
                    <div class="adminStat"><span>Score</span><strong>${fmtNum(wallet.score)}</strong></div>
                    <div class="adminStat"><span>Win Rate</span><strong>${fmtPct(wallet.win_rate)}</strong></div>
                    <div class="adminStat"><span>Avg ROI</span><strong>${fmtNum(wallet.avg_roi_pct,1)}%</strong></div>
                    <div class="adminStat"><span>Total Trades</span><strong>${fmtNum(wallet.total_trades)}</strong></div>
                    <div class="adminStat"><span>Risk Profile</span><strong>${wallet.risk_profile || "-"}</strong></div>
                    <div class="adminStat"><span>Realized Profit</span><strong>${fmtUsd(wallet.realized_profit_usd)}</strong></div>
                    <div class="adminStat"><span>Avg Holding Time</span><strong>${fmtDuration(wallet.avg_holding_seconds)}</strong></div>
                    <div class="adminStat"><span>Last Seen</span><strong>${wallet.last_seen || "-"}</strong></div>
                </div>
                <button class="adminActionBtn" style="margin-top:12px;" data-detail="${wallet.wallet_address}">View Full Detail</button>
            </div>
        `;

        resultEl.querySelector("[data-detail]").onclick = () => openWalletDetail(wallet.wallet_address);

    }
    catch(e){

        resultEl.innerHTML = `<p class="adminNote">No tracked wallet found at this address.</p>`;

    }

};

// =====================================
// WALLET DETAIL MODAL (Product Improvement Sprint, Part 4) - reuses
// the same real GET /wallets/:address profile endpoint the search box
// above already calls (now extended with bestTrade/worstTrade/
// openPositions/predictionHistory - see walletQueryService.js). No
// chart library dependency - two small real canvas line charts
// (Historical Performance from wallet_score_history, Profit/Loss from
// real closed positions' profit_usd over time).
// =====================================

const walletDetailModal = document.getElementById("walletDetailModal");
const walletDetailBody = document.getElementById("walletDetailBody");
const walletDetailTitle = document.getElementById("walletDetailTitle");

function closeWalletDetail(){

    walletDetailModal.classList.add("hidden");

    walletDetailBody.innerHTML = "";

}

document.getElementById("walletDetailCloseBtn").onclick = closeWalletDetail;

walletDetailModal.addEventListener("click", (e) => { if(e.target === walletDetailModal) closeWalletDetail(); });

document.addEventListener("keyup", (e) => { if(e.key === "Escape" && !walletDetailModal.classList.contains("hidden")) closeWalletDetail(); });

// Minimal real line-chart renderer - no fabricated data, no external
// library. Draws a device-pixel-ratio-aware line + filled area for a
// real numeric series; `values` with fewer than 2 real points renders
// a "not enough data yet" note instead of a flat/misleading line.

function drawSparkline(canvas, values, { positiveColor = "#16c784", negativeColor = "#ff5c5c" } = {}){

    const real = values.filter(v => v != null && !isNaN(v));

    const ctx = canvas.getContext("2d");

    const dpr = window.devicePixelRatio || 1;

    const w = canvas.clientWidth || 400;

    const h = canvas.clientHeight || 140;

    canvas.width = w * dpr;

    canvas.height = h * dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, w, h);

    if(real.length < 2) return false;

    const min = Math.min(...real, 0);

    const max = Math.max(...real, 0);

    const range = (max - min) || 1;

    const pad = 8;

    const stepX = (w - pad*2) / (real.length - 1);

    const xAt = i => pad + i*stepX;

    const yAt = v => h - pad - ((v - min) / range) * (h - pad*2);

    const last = real[real.length - 1];

    const color = last >= (real[0] ?? 0) ? positiveColor : negativeColor;

    // Zero line, when zero is within range (profit/loss charts).
    if(min < 0 && max > 0){

        ctx.strokeStyle = "rgba(255,255,255,.15)";

        ctx.beginPath();

        ctx.moveTo(0, yAt(0));

        ctx.lineTo(w, yAt(0));

        ctx.stroke();

    }

    ctx.beginPath();

    real.forEach((v, i) => { const x = xAt(i), y = yAt(v); if(i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });

    ctx.lineTo(xAt(real.length-1), h - pad);

    ctx.lineTo(xAt(0), h - pad);

    ctx.closePath();

    ctx.fillStyle = color + "22";

    ctx.fill();

    ctx.beginPath();

    real.forEach((v, i) => { const x = xAt(i), y = yAt(v); if(i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });

    ctx.strokeStyle = color;

    ctx.lineWidth = 2;

    ctx.stroke();

    ctx.fillStyle = color;

    ctx.beginPath();

    ctx.arc(xAt(real.length-1), yAt(last), 3, 0, Math.PI*2);

    ctx.fill();

    return true;

}

function tradeRowHtml(label, trade){

    if(!trade) return `<div class="adminStat"><span>${label}</span><strong>No closed trades yet</strong></div>`;

    return `
        <div class="adminStat">
            <span>${label}</span>
            <strong>${trade.roi_pct != null ? trade.roi_pct.toFixed(1)+"%" : "-"} on ${trade.token_symbol || shortAddr(trade.token_address)}</strong>
            <span style="font-size:11px;color:var(--muted);">${fmtUsd(trade.profit_usd)} · held ${fmtDuration(trade.holding_seconds)} · exited ${trade.exit_time || "-"}</span>
        </div>
    `;

}

async function openWalletDetail(address){

    walletDetailTitle.textContent = `Wallet Detail - ${address}`;

    walletDetailBody.innerHTML = `<p class="adminNote">Loading...</p>`;

    walletDetailModal.classList.remove("hidden");

    try{

        const profile = await publicFetch(`/wallets/${encodeURIComponent(address)}`);

        const w = profile.wallet;

        const open = profile.openPositions || [];

        const scoreHistory = profile.scoreHistory || [];

        const closed = (profile.recentPositions || []).filter(p => p.status === "closed").sort((a,b) => new Date(a.exit_time) - new Date(b.exit_time));

        walletDetailBody.innerHTML = `

            <div class="adminGrid4">
                <div class="adminStat"><span>Score</span><strong>${fmtNum(w.score)}</strong></div>
                <div class="adminStat"><span>Label</span><strong>${w.primary_label || "Unproven"}</strong></div>
                <div class="adminStat"><span>Total Trades</span><strong>${fmtNum(w.total_trades)}</strong></div>
                <div class="adminStat"><span>Win Rate</span><strong>${fmtPct(w.win_rate)}</strong></div>
                <div class="adminStat"><span>Average ROI</span><strong>${w.avg_roi_pct!=null?w.avg_roi_pct.toFixed(1)+"%":"-"}</strong></div>
                <div class="adminStat"><span>Median ROI</span><strong>${w.median_roi_pct!=null?w.median_roi_pct.toFixed(1)+"%":"-"}</strong></div>
                <div class="adminStat"><span>Realized Profit</span><strong>${fmtUsd(w.realized_profit_usd)}</strong></div>
                <div class="adminStat"><span>Avg Holding Time</span><strong>${fmtDuration(w.avg_holding_seconds)}</strong></div>
                <div class="adminStat"><span>Engine Weight</span><strong style="font-size:12px;font-weight:500;">${engineWeightForLabel(w.primary_label)}</strong></div>
                <div class="adminStat"><span>Confidence (last score)</span><strong>${fmtNum(w.confidence)}</strong></div>
                <div class="adminStat"><span>Behavior (Risk Profile)</span><strong>${w.risk_profile || "-"}</strong></div>
            </div>

            <h4>Best / Worst Trade (real, individual closed positions)</h4>
            <div class="adminGrid4">
                ${tradeRowHtml("Best Trade", profile.bestTrade)}
                ${tradeRowHtml("Worst Trade", profile.worstTrade)}
                <div class="adminStat"><span>Best ROI (all-time, stored)</span><strong>${w.best_roi_pct!=null?w.best_roi_pct.toFixed(1)+"%":"-"}</strong></div>
                <div class="adminStat"><span>Worst ROI (all-time, stored)</span><strong>${w.worst_roi_pct!=null?w.worst_roi_pct.toFixed(1)+"%":"-"}</strong></div>
            </div>

            <h4>Current Holdings (${open.length} open position${open.length===1?"":"s"})</h4>
            ${open.length ? `
                <div class="adminTableWrap">
                    <table class="adminTable">
                        <thead><tr><th>Token</th><th>Entry Time</th><th>Entry Price</th><th>Current Price</th><th>Unrealized ROI</th><th>Est. Current Value</th></tr></thead>
                        <tbody>
                        ${open.map(p => `
                            <tr>
                                <td>${p.token_symbol || shortAddr(p.token_address)}</td>
                                <td>${p.entry_time}</td>
                                <td>${p.entry_price!=null?"$"+p.entry_price:"-"}</td>
                                <td>${p.currentPrice!=null?"$"+p.currentPrice:"n/a"}</td>
                                <td>${p.unrealizedRoiPct!=null?p.unrealizedRoiPct.toFixed(1)+"%":"n/a"}</td>
                                <td>${p.currentValueUsd!=null?fmtUsd(p.currentValueUsd):"n/a"}</td>
                            </tr>
                        `).join("")}
                        </tbody>
                    </table>
                </div>
                <p class="adminNote">Current price is this token's last GMGN scan (~30s cadence), not a live quote at the moment you're viewing this.</p>
            ` : `<p class="adminNote">No open positions.</p>`}

            <h4>Historical Performance (real score over time)</h4>
            <div class="adminModalChartWrap"><canvas id="walletDetailScoreChart"></canvas></div>
            <p class="adminNote" id="walletDetailScoreNote"></p>

            <h4>Profit / Loss (real closed trades, chronological)</h4>
            <div class="adminModalChartWrap"><canvas id="walletDetailPnlChart"></canvas></div>
            <p class="adminNote" id="walletDetailPnlNote"></p>

            <h4>Prediction History</h4>
            <p class="adminNote">${profile.predictionHistory?.reason || "Not available."}</p>

        `;

        const scoreValues = scoreHistory.slice().reverse().map(s => s.score);

        const scoreOk = drawSparkline(document.getElementById("walletDetailScoreChart"), scoreValues);

        document.getElementById("walletDetailScoreNote").textContent = scoreOk
            ? `${scoreValues.length} real recompute snapshots shown, oldest to newest.`
            : "Not enough historical snapshots yet for this wallet.";

        const pnlValues = closed.map(p => p.profit_usd);

        const pnlOk = drawSparkline(document.getElementById("walletDetailPnlChart"), pnlValues);

        document.getElementById("walletDetailPnlNote").textContent = pnlOk
            ? `${pnlValues.length} real closed trades shown, oldest to newest (per-trade profit/loss in USD, not cumulative).`
            : "Not enough closed trades yet for this wallet.";

    }
    catch(e){

        console.error(e);

        walletDetailBody.innerHTML = `<p class="adminNote">No data available.</p>`;

    }

}

// =====================================
// TOKEN
// =====================================

function actionPillClass(action){

    if(action === "STRONG BUY") return "strongbuy";

    if(action === "BUY") return "buy";

    if(action === "HOLD") return "hold";

    return "avoid";

}

async function runTokenSearch(){

    const q = document.getElementById("tokenSearchInput").value.trim();

    const resultEl = document.getElementById("tokenSearchResult");

    if(q.length < 2){ resultEl.innerHTML = ""; return; }

    resultEl.innerHTML = `<p class="adminNote">Searching local cache, then DexScreener if needed...</p>`;

    try{

        const result = await publicFetch(`/search?q=${encodeURIComponent(q)}&limit=10`);

        if(!result.tokens.length){

            resultEl.innerHTML = `<p class="adminNote">No token matched "${q}" - not found locally or on DexScreener.</p>`;

            return;

        }

        resultEl.innerHTML = result.tokens.map(t => tokenRowHtml(t)).join("");

    }
    catch(e){

        console.error(e);

        resultEl.innerHTML = `<p class="adminNote">No data available.</p>`;

    }

}

document.getElementById("tokenSearchBtn").onclick = runTokenSearch;

document.getElementById("tokenSearchInput").addEventListener("keyup", (e) => { if(e.key === "Enter") runTokenSearch(); });

function tokenRowHtml(t){

    const addr = t.token_address;

    return `
        <div class="adminTokenRow" data-address="${addr}">
            <div class="adminTokenRowHead">
                <strong>${t.symbol} <span style="color:var(--muted);font-weight:400;">${t.name||""}</span></strong>
                <span class="adminPill ${actionPillClass(t.signal.action)}">${t.signal.action}</span>
            </div>
            <div class="adminGrid4">
                <div class="adminStat"><span>Participant Score</span><strong>${t.signal.participantScore}</strong></div>
                <div class="adminStat"><span>Confidence</span><strong>${t.signal.confidence}%</strong></div>
                <div class="adminStat"><span>Market Cap</span><strong>${fmtUsd(t.market_cap)}</strong></div>
                <div class="adminStat"><span>Liquidity</span><strong>${fmtUsd(t.liquidity)}</strong></div>
            </div>
            <div class="adminTokenActions">
                <button class="adminActionBtn" data-act="refresh">Refresh Token</button>
                <button class="adminActionBtn" data-act="reanalyze">Analyze Again</button>
                <button class="adminActionBtn" data-act="cache">Delete Cache</button>
                <a class="adminActionBtn" href="${dexscreenerLink(addr)}" target="_blank" rel="noopener noreferrer">Open Dex</a>
                <a class="adminActionBtn" href="${gmgnLink(addr)}" target="_blank" rel="noopener noreferrer">Open GMGN</a>
                <button class="adminActionBtn" data-act="detail">Lihat Detail</button>
            </div>
            <div class="adminTokenDetail hidden" data-role="detail"></div>
        </div>
    `;

}

document.getElementById("tokenSearchResult").addEventListener("click", async (e) => {

    const btn = e.target.closest(".adminActionBtn[data-act]");

    if(!btn) return;

    const row = e.target.closest(".adminTokenRow");

    const address = row.dataset.address;

    const act = btn.dataset.act;

    const detailEl = row.querySelector('[data-role="detail"]');

    btn.disabled = true;

    const originalLabel = btn.textContent;

    btn.textContent = "Working...";

    try{

        if(act === "refresh"){

            const r = await adminFetch(`/admin/tokens/${encodeURIComponent(address)}/refresh`, { method: "POST" });

            detailEl.classList.remove("hidden");

            detailEl.textContent = r.refreshed ? `Refreshed: ${r.symbol} @ ${fmtUsd(r.marketCap)} MC, ${fmtUsd(r.price)} price` : `Not refreshed: ${r.reason}`;

        }
        else if(act === "reanalyze"){

            const r = await adminFetch(`/admin/tokens/${encodeURIComponent(address)}/reanalyze`, { method: "POST" });

            detailEl.classList.remove("hidden");

            detailEl.textContent = `Re-analyzed: action=${r.token.signal.action}, participantScore=${r.token.signal.participantScore}, confidence=${r.token.signal.confidence}%, tradePlan=${r.tradePlan.riskBands?.status || "numeric bands"}`;

        }
        else if(act === "cache"){

            const r = await adminFetch(`/admin/tokens/${encodeURIComponent(address)}/cache`, { method: "DELETE" });

            detailEl.classList.remove("hidden");

            detailEl.textContent = `Deleted ${r.deleted} cached on-demand fact(s) for this token.`;

        }
        else if(act === "detail"){

            const full = await publicFetch(`/token/${encodeURIComponent(address)}`);

            detailEl.classList.remove("hidden");

            const rb = full.tradePlan.riskBands;

            const planLine = rb?.status === "waiting_for_confirmation"

                ? `Trade Plan: waiting for confirmation - ${rb.reasons.join(" ")}`

                : rb ? `Trade Plan: Entry ${fmtUsd(rb.entryZone.lowMc)}-${fmtUsd(rb.entryZone.highMc)} MC, Target ${fmtUsd(rb.target.marketCap)} (+${rb.target.expectedMovePct.toFixed(0)}%), Stop ${fmtUsd(rb.stopLoss.marketCap)} (-${rb.stopLoss.distancePct.toFixed(0)}%)` : "Trade Plan: unavailable";

            detailEl.textContent =

                `Action: ${full.signal.action} | Risk: ${full.signal.risk} | Lifecycle: ${full.signal.lifecycle}\n` +
                `Reasons: ${full.signal.reasons.join("; ") || "none"}\n` +
                `Risk flags: ${full.signal.riskReasons.join("; ") || "none"}\n` +
                `${planLine}`;

        }

    }
    catch(err){

        detailEl.classList.remove("hidden");

        detailEl.textContent = `Error: ${err.message}`;

    }
    finally{

        btn.disabled = false;

        btn.textContent = originalLabel;

    }

});

// =====================================
// ENGINE (read-only)
// =====================================

function kvTable(title, obj){

    const rows = Object.entries(obj).map(([k,v]) => `<tr><td>${k}</td><td>${typeof v === "object" ? JSON.stringify(v) : v}</td></tr>`).join("");

    return `
        <div class="adminTableWrap">
            <table class="adminTable">
                <caption>${title}</caption>
                <thead><tr><th>Parameter</th><th>Value</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;

}

// =====================================
// ENGINE STATUS (Admin V3 Section 1) - also updates the Dashboard's
// small "Engine Version" teaser card from this same fetch, since both
// display the same real value from one backend call.
// =====================================

function renderEngineStatus(s){

    const versionEl = document.getElementById("dashEngineVersion");

    if(versionEl) versionEl.textContent = s.engineVersion;

    document.getElementById("ceoStatusRow").innerHTML = `
        <div class="adminStat"><span>Engine Version</span><strong>${s.engineVersion}</strong></div>
        <div class="adminStat"><span>AI Model Version</span><strong>${s.aiModelVersion}</strong></div>
        <div class="adminStat"><span>Prediction Engine</span><strong>${s.predictionEngineStatus.toUpperCase()}</strong></div>
        <div class="adminStat"><span>Validation Scheduler</span><strong>${s.validationSchedulerStatus.toUpperCase()}</strong></div>
        <div class="adminStat"><span>Database</span><strong>${s.databaseStatus}</strong></div>
        <div class="adminStat"><span>Version Notes</span><strong style="font-size:11px;font-weight:400;color:var(--muted);">${s.engineVersionNotes.slice(0,90)}...</strong></div>
    `;

}

// =====================================
// ENGINE EVOLUTION (Admin V3 Section 9)
// =====================================

function renderEngineHistory(history){

    const el = document.getElementById("ceoEngineHistory");

    if(!history.length){ el.innerHTML = `<p class="adminNote">No version recorded yet.</p>`; return; }

    el.innerHTML = `
        <table class="adminTable">
            <thead><tr>
                <th>Version</th><th>Deployed</th><th>Win Rate</th><th>Avg ROI</th>
                <th>Predictions</th><th>Win Rate Δ vs Previous</th><th>Avg ROI Δ vs Previous</th>
            </tr></thead>
            <tbody>
            ${history.map(v => `
                <tr>
                    <td>${v.version}</td>
                    <td>${v.deployedAt}</td>
                    <td>${v.winRate!=null?fmtPct(v.winRate):"n/a"}</td>
                    <td>${v.averageRoiPct!=null?v.averageRoiPct.toFixed(1)+"%":"-"}</td>
                    <td>${fmtNum(v.predictionCount)}</td>
                    <td>${v.winRateDelta != null ? fmtPct(v.winRateDelta) : "n/a (first version)"}</td>
                    <td>${v.averageRoiDelta != null ? v.averageRoiDelta.toFixed(1)+"%" : "n/a (first version)"}</td>
                </tr>
            `).join("")}
            </tbody>
        </table>
    `;

}

// =====================================
// LEARN SYSTEM (Product Improvement Sprint, Part 7, NEW) - reads GET
// /admin/learn/summary, which is real, append-only day-over-day
// history (engine_daily_metrics, migration 013) - started recording
// the day this sprint shipped, never backfilled with invented history
// for earlier days. Honestly reports "not enough data yet" until at
// least 2 real days exist.
// =====================================

function deltaCardHtml(label, described){

    if(!described) return `<div class="ceoSignalCard hold"><span class="ceoSignalLabel">${label}</span><span class="ceoSignalPct">No change</span></div>`;

    const cls = described.dir === "improved" ? "strongbuy" : (described.dir === "worsened" ? "avoid" : "hold");

    return `<div class="ceoSignalCard ${cls}"><span class="ceoSignalLabel">${described.label}</span><span class="ceoSignalCount" style="font-size:16px;">${described.delta}</span><span class="ceoSignalPct">${described.dir}</span></div>`;

}

function renderLearnSummary(data){

    const summaryEl = document.getElementById("learnSummary");

    if(!data.available){

        summaryEl.innerHTML = `<p class="adminNote">${data.reason}</p>`;

    }
    else{

        const changes = [data.walletCategoryChange, data.tokenPatternChange, data.confidenceHealthChange].filter(Boolean);

        summaryEl.innerHTML = `
            <p class="adminNote">Comparing ${data.latestDate} (most recent real day) to ${data.previousDate} (${data.realDaysRecorded} real days recorded so far).</p>
            <div class="ceoSignalGrid">
                <div class="ceoSignalCard ${data.overallWinRateDelta > 0 ? "strongbuy" : (data.overallWinRateDelta < 0 ? "avoid" : "hold")}">
                    <span class="ceoSignalLabel">Overall Win Rate</span>
                    <span class="ceoSignalCount" style="font-size:16px;">${data.overallWinRateDelta != null ? (data.overallWinRateDelta > 0 ? "+" : "") + data.overallWinRateDelta.toFixed(1) + "pp" : "n/a"}</span>
                </div>
                <div class="ceoSignalCard ${data.averageRoiDelta > 0 ? "strongbuy" : (data.averageRoiDelta < 0 ? "avoid" : "hold")}">
                    <span class="ceoSignalLabel">Average ROI</span>
                    <span class="ceoSignalCount" style="font-size:16px;">${data.averageRoiDelta != null ? (data.averageRoiDelta > 0 ? "+" : "") + data.averageRoiDelta.toFixed(1) + "%" : "n/a"}</span>
                </div>
            </div>
            <h4>What Improved</h4>
            ${data.whatImproved.length ? `<div class="ceoSignalGrid">${data.whatImproved.map(d => deltaCardHtml(d.label, d)).join("")}</div>` : `<p class="adminNote">Nothing improved by a meaningful margin.</p>`}
            <h4>What Got Worse</h4>
            ${data.whatWorsened.length ? `<div class="ceoSignalGrid">${data.whatWorsened.map(d => deltaCardHtml(d.label, d)).join("")}</div>` : `<p class="adminNote">Nothing got meaningfully worse.</p>`}
            ${changes.length ? `<h4>Other Changes</h4><ul>${changes.map(c => `<li class="adminNote">${c}</li>`).join("")}</ul>` : ""}
        `;

    }

    const historyEl = document.getElementById("learnHistory");

    if(!data.history || !data.history.length){ historyEl.innerHTML = `<p class="adminNote">No data available.</p>`; return; }

    historyEl.innerHTML = `
        <table class="adminTable">
            <thead><tr>
                <th>Date</th><th>Predictions</th><th>Win Rate</th><th>Average ROI</th>
                <th>Best Wallet Category</th><th>Worst Wallet Category</th><th>Confidence Health</th>
            </tr></thead>
            <tbody>
            ${data.history.map(h => `
                <tr>
                    <td>${h.date}</td>
                    <td>${fmtNum(h.predictionCount)}</td>
                    <td>${h.winRate!=null?fmtPct(h.winRate):"n/a"}</td>
                    <td>${h.averageRoiPct!=null?h.averageRoiPct.toFixed(1)+"%":"-"}</td>
                    <td>${h.bestWalletCategory || "-"}</td>
                    <td>${h.worstWalletCategory || "-"}</td>
                    <td>${h.confidenceHealthStatus || "-"}</td>
                </tr>
            `).join("")}
            </tbody>
        </table>
    `;

}

// =====================================
// AI ENGINE ADVISOR (Admin V3 Section 8)
// =====================================

// AI Engine Advisor (Admin V3.1, Part 7 - moved to the top of the
// page, restructured to answer "what should I improve today?" at a
// glance): a top-level summary (current/previous win rate, primary/
// secondary problem, suggested fix, expected improvement, confidence,
// current/recommended parameter - all real, from
// ceoDashboardService.getEngineAdvisor()) followed by the full list of
// every rule that crossed its real threshold this period.

function renderEngineAdvisorSummary(data){

    const summaryEl = document.getElementById("ceoEngineAdvisorSummary");

    const deltaHtml = data.winRateDelta != null
        ? `<span class="ceoTrend ${data.winRateDelta > 0 ? "up" : (data.winRateDelta < 0 ? "down" : "flat")}">${data.winRateDelta > 0 ? "+" : ""}${(data.winRateDelta*100).toFixed(1)}pp</span>`
        : `<span class="ceoTrend flat">${data.previousPeriodAvailable === false ? "n/a (no previous period for All Time)" : "n/a"}</span>`;

    summaryEl.innerHTML = `
        <div class="adminStat"><span>Current Win Rate</span><strong>${data.currentWinRate!=null?fmtPct(data.currentWinRate):"n/a"}</strong></div>
        <div class="adminStat"><span>Previous Win Rate</span><strong>${data.previousWinRate!=null?fmtPct(data.previousWinRate):"n/a"}</strong></div>
        <div class="adminStat"><span>Difference</span><strong>${deltaHtml}</strong></div>
        <div class="adminStat"><span>Confidence</span><strong>${data.confidence || "-"}</strong></div>
        <div class="adminStat" style="grid-column:span 2;"><span>Primary Problem</span><strong style="font-size:13px;font-weight:500;">${data.primaryProblem || "No rule crossed its real threshold this period - nothing urgent to flag."}</strong></div>
        <div class="adminStat" style="grid-column:span 2;"><span>Secondary Problem</span><strong style="font-size:13px;font-weight:500;">${data.secondaryProblem || "n/a"}</strong></div>
        <div class="adminStat" style="grid-column:span 2;"><span>Suggested Fix</span><strong style="font-size:13px;font-weight:500;">${data.suggestedFix || "n/a"}</strong></div>
        <div class="adminStat"><span>Current Parameter</span><strong>${data.currentParameter ?? "n/a"}</strong></div>
        <div class="adminStat"><span>Recommended Parameter</span><strong>${data.recommendedParameter ?? "n/a"}</strong></div>
        <div class="adminStat" style="grid-column:span 2;"><span>Expected Improvement</span><strong style="font-size:13px;font-weight:500;">${data.expectedImprovement || "Not quantifiable from current data"}</strong></div>
    `;

    const el = document.getElementById("ceoEngineAdvisor");

    if(!data.advisories.length){

        el.innerHTML = `<p class="adminNote">No further rule crossed its real threshold for this period.</p>`;

        return;

    }

    const warning = data.sampleWarning ? `<p class="adminNote">${data.sampleWarning}</p>` : "";

    el.innerHTML = warning + `<p class="adminNote" style="margin-top:10px;">All flagged issues this period, ranked by priority:</p>` + data.advisories.map(a => `
        <div class="ceoInsightCard">
            <div class="ceoInsightCardHead">
                <span class="ceoInsightMessage"><strong>#${a.priority} - ${a.reason}</strong></span>
                <span class="ceoImpactBadge severity-${a.severity.toLowerCase()}">${a.severity} Severity</span>
            </div>
            <div class="ceoAdvisorGrid">
                <div><span>Current Value</span>${a.currentValue ?? "n/a - no direct engine parameter"}</div>
                <div><span>Suggested Value</span>${a.recommendedValue ?? "n/a"}</div>
                <div><span>Estimated Win Rate Improvement</span>${a.estimatedWinRateImprovementPct != null ? `+${a.estimatedWinRateImprovementPct.toFixed(1)}pp (optimistic upper bound)` : "Not quantifiable from current data"}</div>
                <div><span>Sample Size</span>${fmtNum(a.sampleSize)}</div>
                <div><span>Confidence</span>${a.confidence}</div>
                <div><span>Priority</span>#${a.priority}</div>
                <div style="grid-column:1/-1;"><span>Evidence</span>${a.evidence}</div>
                <div style="grid-column:1/-1;"><span>Expected Improvement</span>${a.expectedImprovement ?? "Not quantifiable from current data"}</div>
                <div><span>Affected Parameter</span>${a.affectedParameter ?? "No direct engine parameter"}</div>
                <div style="grid-column:1/-1;"><span>How To Implement</span>${a.implementation ?? "No direct config change - treat as a directional signal to investigate manually."}</div>
            </div>
        </div>
    `).join("");

}

async function loadEngineAdvisor(){

    await loadOne(

        adminFetch(`/admin/ceo/engine-advisor${buildFilterParams()}`),

        renderEngineAdvisorSummary,

        () => { noData("ceoEngineAdvisorSummary"); noData("ceoEngineAdvisor"); }

    );

}

// Cached for Wallet Detail's real "Engine Weight" field (Product
// Refinement Sprint, Part 7) - avoids a second admin-gated fetch
// inside the modal; refreshed every time the Engine section loads.

let cachedEngineConfig = null;

// Real, disclosed, PARTIAL mapping from a wallet's GMGN label to its
// actual scored participant-weight key in scoringConfig.js - only 4 of
// the 10 real primary_label values correspond 1:1 to a real scored
// category. The rest (Sniper - inversely risk-scored, not a positive
// weight; Scalper/Swing Trader/Long Holder/Trader/Unproven - pure
// behavior classifications with no participant-score entry at all) are
// honestly reported as not directly scored, never guessed.

const WALLET_LABEL_TO_WEIGHT_KEY = { "Smart Money": "smartMoney", "Developer": "developer", "KOL Trader": "kol", "Whale": "whale" };

function engineWeightForLabel(label){

    const key = WALLET_LABEL_TO_WEIGHT_KEY[label];

    if(!key || !cachedEngineConfig) return "Not a directly-scored participant category";

    return `${cachedEngineConfig.participantWeights[key]} (participant score weight for "${label}")`;

}

function renderEngineConfig(c){

    cachedEngineConfig = c;

    const html =

        kvTable("Action Tiers (real 4-tier system: STRONG BUY / BUY / HOLD / AVOID)", c.actionTiers) +

        kvTable("Confidence Formula", c.confidence) +

        kvTable("Safety Veto (hard AVOID triggers)", c.safetyVeto) +

        kvTable("Participant Score Weights (sum = 100)", c.participantWeights) +

        kvTable("Market Health Weights (sum = 100)", c.marketWeights) +

        kvTable("Structural Self-Validation (outcome-based penalty)", c.structuralValidation) +

        kvTable("Trade Plan - Entry Zone", c.tradePlan.entryZone) +

        kvTable("Trade Plan - Target", c.tradePlan.target) +

        kvTable("Trade Plan - Stop Loss", c.tradePlan.stopLoss) +

        kvTable("Trade Plan - Readiness Gate", c.tradePlan.readiness);

    document.getElementById("engineConfigTables").innerHTML = html;

}

// =====================================
// PREDICTION
// =====================================

// =====================================
// PREDICTION VALIDATION (prediction_history-based, date-filterable -
// UX sprint Part 2)
// =====================================

// Result Summary ONLY (Admin V3 split this out of one big block into
// its own container - Signal Summary/Strong Buy/Failure Analysis/
// Confidence Calibration each now have their own function+container).

function renderPredValidationSummary(summary){

    document.getElementById("predValidationSummary").innerHTML = `
        <div class="adminGrid4">
            <div class="adminStat"><span>Total Predictions</span><strong>${fmtNum(summary.predictionCount)}</strong></div>
            <div class="adminStat"><span>TP Hit</span><strong>${fmtNum(summary.tpCount)}</strong></div>
            <div class="adminStat"><span>SL Hit</span><strong>${fmtNum(summary.slCount)}</strong></div>
            <div class="adminStat"><span>Expired</span><strong>${fmtNum(summary.expiredCount)}</strong></div>
            <div class="adminStat"><span>Open</span><strong>${fmtNum(summary.openCount)}</strong></div>
            <div class="adminStat"><span>Win Rate</span><strong>${summary.winRate!=null?fmtPct(summary.winRate):"n/a"}</strong></div>
            <div class="adminStat"><span>Average ROI</span><strong>${summary.averageRoiPct!=null?summary.averageRoiPct.toFixed(2)+"%":"-"}</strong></div>
            <div class="adminStat"><span>Median ROI</span><strong>${summary.medianRoiPct!=null?summary.medianRoiPct.toFixed(2)+"%":"-"}</strong></div>
            <div class="adminStat"><span>Largest Winner</span><strong>${summary.largestWinnerPct!=null?summary.largestWinnerPct.toFixed(1)+"%":"-"}</strong></div>
            <div class="adminStat"><span>Largest Loser</span><strong>${summary.largestLoserPct!=null?summary.largestLoserPct.toFixed(1)+"%":"-"}</strong></div>
            <div class="adminStat"><span>Avg Time to TP</span><strong>${fmtDuration(summary.averageTimeToTpSeconds)}</strong></div>
            <div class="adminStat"><span>Avg Time to SL</span><strong>${fmtDuration(summary.averageTimeToSlSeconds)}</strong></div>
        </div>
    `;

}

// Signal Summary (Admin V3 Section 3) - count/percentage/trend per tier.

function trendHtml(trendCount, trendPct){

    if(trendCount == null) return `<span class="ceoTrend flat">No prior period</span>`;

    const dir = trendCount > 0 ? "up" : (trendCount < 0 ? "down" : "flat");

    const arrow = dir === "up" ? "▲" : (dir === "down" ? "▼" : "—");

    const pctStr = trendPct != null ? ` (${(trendPct*100).toFixed(0)}%)` : "";

    return `<span class="ceoTrend ${dir}">${arrow} ${trendCount > 0 ? "+" : ""}${trendCount}${pctStr} vs previous period</span>`;

}

function renderSignalSummary(data){

    const classFor = { "STRONG BUY": "strongbuy", "BUY": "buy", "HOLD": "hold", "AVOID": "avoid" };

    document.getElementById("ceoSignalSummary").innerHTML = data.tiers.map(t => `
        <div class="ceoSignalCard ${classFor[t.recommendation]}">
            <span class="ceoSignalLabel">${t.recommendation}</span>
            <span class="ceoSignalCount">${fmtNum(t.count)}</span>
            <span class="ceoSignalPct">${t.percentage!=null?fmtPct(t.percentage):"n/a"} of ${fmtNum(data.total)} total</span>
            ${trendHtml(t.trendCount, t.trendPct)}
        </div>
    `).join("");

}

// Strong Buy Analysis (Admin V3 Section 6)

function renderStrongBuyCeo(s){

    document.getElementById("ceoStrongBuy").innerHTML = `
        <div class="adminStat"><span>Issued</span><strong>${fmtNum(s.predictionCount)}</strong></div>
        <div class="adminStat"><span>TP</span><strong>${fmtNum(s.tpCount)}</strong></div>
        <div class="adminStat"><span>SL</span><strong>${fmtNum(s.slCount)}</strong></div>
        <div class="adminStat"><span>Expired</span><strong>${fmtNum(s.expiredCount)}</strong></div>
        <div class="adminStat"><span>Open</span><strong>${fmtNum(s.openCount)}</strong></div>
        <div class="adminStat"><span>Win Rate</span><strong>${s.winRate!=null?fmtPct(s.winRate):"n/a"}</strong></div>
        <div class="adminStat"><span>Average ROI</span><strong>${s.averageRoiPct!=null?s.averageRoiPct.toFixed(1)+"%":"-"}</strong></div>
        <div class="adminStat"><span>Avg Time to TP</span><strong>${fmtDuration(s.averageTimeToTpSeconds)}</strong></div>
    `;

}

// Failure Analysis (Admin V3 Section 7) - headlines (top losing/
// winning reason, best/worst wallet category, most/least profitable
// token pattern) + 4 real bar charts.

function barRowCeo(label, count, max){

    const pct = max > 0 ? Math.min(100, (count/max)*100) : 0;

    return `
        <div class="adminBarRow">
            <div class="adminBarLabel"><span>${label}</span><strong>${count}</strong></div>
            <div class="adminBarTrack"><div class="adminBarFill" style="width:${pct}%"></div></div>
        </div>
    `;

}

function renderFailureAnalysisCeo(f){

    document.getElementById("ceoFailureHeadlines").innerHTML = `
        <div class="ceoSignalCard avoid">
            <span class="ceoSignalLabel">Top Losing Reason</span>
            <span class="ceoSignalCount" style="font-size:16px;">${f.mostCommonLosingReason ? f.mostCommonLosingReason.reason : "n/a"}</span>
            <span class="ceoSignalPct">${f.mostCommonLosingReason ? fmtNum(f.mostCommonLosingReason.count) + " occurrences" : "No losses yet"}</span>
        </div>
        <div class="ceoSignalCard strongbuy">
            <span class="ceoSignalLabel">Top Winning Reason</span>
            <span class="ceoSignalCount" style="font-size:16px;">${f.mostCommonWinningReason ? f.mostCommonWinningReason.reason : "n/a"}</span>
            <span class="ceoSignalPct">${f.mostCommonWinningReason ? fmtNum(f.mostCommonWinningReason.count) + " occurrences" : "No wins with a reason yet"}</span>
        </div>
        <div class="ceoSignalCard buy">
            <span class="ceoSignalLabel">Best Wallet Category</span>
            <span class="ceoSignalCount" style="font-size:16px;">${f.bestWalletCategory ? f.bestWalletCategory.key : "n/a"}</span>
            <span class="ceoSignalPct">${f.bestWalletCategory ? fmtPct(f.bestWalletCategory.winRate) + ` win rate (n=${f.bestWalletCategory.sampleSize})` : "Not enough sample yet"}</span>
        </div>
        <div class="ceoSignalCard hold">
            <span class="ceoSignalLabel">Worst Wallet Category</span>
            <span class="ceoSignalCount" style="font-size:16px;">${f.worstWalletCategory ? f.worstWalletCategory.key : "n/a"}</span>
            <span class="ceoSignalPct">${f.worstWalletCategory ? fmtPct(f.worstWalletCategory.winRate) + ` win rate (n=${f.worstWalletCategory.sampleSize})` : "Not enough sample yet"}</span>
        </div>
        <div class="ceoSignalCard strongbuy">
            <span class="ceoSignalLabel">Most Profitable Token Pattern</span>
            <span class="ceoSignalCount" style="font-size:16px;">${f.mostProfitableTokenPattern ? f.mostProfitableTokenPattern.key : "n/a"}</span>
            <span class="ceoSignalPct">${f.mostProfitableTokenPattern ? fmtPct(f.mostProfitableTokenPattern.winRate) + ` win rate (n=${f.mostProfitableTokenPattern.sampleSize})` : "Not enough sample yet"}</span>
        </div>
        <div class="ceoSignalCard avoid">
            <span class="ceoSignalLabel">Most Dangerous Token Pattern</span>
            <span class="ceoSignalCount" style="font-size:16px;">${f.mostDangerousTokenPattern ? f.mostDangerousTokenPattern.key : "n/a"}</span>
            <span class="ceoSignalPct">${f.mostDangerousTokenPattern ? fmtPct(f.mostDangerousTokenPattern.winRate) + ` win rate (n=${f.mostDangerousTokenPattern.sampleSize})` : "Not enough sample yet"}</span>
        </div>
        <div class="ceoSignalCard buy">
            <span class="ceoSignalLabel">False BUY</span>
            <span class="ceoSignalCount">${fmtNum(f.falseBuyCount)}</span>
            <span class="ceoSignalPct">STRONG BUY/BUY that didn't hit target</span>
        </div>
        <div class="ceoSignalCard hold">
            <span class="ceoSignalLabel">Missed BUY</span>
            <span class="ceoSignalCount">${fmtNum(f.missedBuyCount)}</span>
            <span class="ceoSignalPct">HOLD that would have hit target anyway</span>
        </div>
    `;

    const maxFailure = Math.max(1, ...f.failureAnalysis.map(r => r.count));

    document.getElementById("ceoFailureReasons").innerHTML = f.failureAnalysis.length

        ? f.failureAnalysis.map(r => barRowCeo(r.reason, r.count, maxFailure)).join("")

        : `<p class="adminNote">No losing predictions in this period yet.</p>`;

    const maxWin = Math.max(1, ...f.winAnalysis.map(r => r.count));

    document.getElementById("ceoWinningReasons").innerHTML = f.winAnalysis.length

        ? f.winAnalysis.map(r => barRowCeo(r.reason, r.count, maxWin)).join("")

        : `<p class="adminNote">No TP-hit predictions with a recorded reason yet (older TP closures predate this analysis).</p>`;

    const maxCat = Math.max(1, ...f.walletCategoryLosses.map(r => r.count));

    document.getElementById("ceoWalletCategoryLosses").innerHTML = f.walletCategoryLosses.length

        ? f.walletCategoryLosses.map(r => barRowCeo(r.category, r.count, maxCat)).join("")

        : `<p class="adminNote">No losing predictions in this period yet.</p>`;

    const maxPattern = Math.max(1, ...f.tokenPatternLosses.map(r => r.count));

    document.getElementById("ceoTokenPatternLosses").innerHTML = f.tokenPatternLosses.length

        ? f.tokenPatternLosses.map(r => barRowCeo(r.pattern, r.count, maxPattern)).join("")

        : `<p class="adminNote">No losing predictions in this period yet.</p>`;

    document.getElementById("ceoConfidenceCalibration").innerHTML = `
        <table class="adminTable">
            <thead><tr><th>Confidence Band</th><th>Predictions</th><th>TP</th><th>SL</th><th>Win Rate</th></tr></thead>
            <tbody>
            ${f.confidenceCalibration.map(b => `
                <tr>
                    <td>${b.label}</td>
                    <td>${fmtNum(b.predictionCount)}</td>
                    <td>${fmtNum(b.tpCount)}</td>
                    <td>${fmtNum(b.slCount)}</td>
                    <td>${b.winRate!=null?fmtPct(b.winRate):"n/a"}</td>
                </tr>
            `).join("")}
            </tbody>
        </table>
    `;

}

// =====================================
// WALLET PERFORMANCE (Admin V3 Section 5) - category tabs + copy button
// =====================================

let activeWalletCategory = null;

// Admin V3.1, Part 5 - full redesign: real search, sort-by-every-real-
// column, and pagination (100/250/500/Show All) over ALL tracked
// wallets, not a fixed Top 20/10. `sortBy`/`direction` mirror the
// frontend-facing keys ceoDashboardService.js's WALLET_SORT_COLUMNS
// maps to real DB columns; "n/a" columns (see the disclosure note in
// admin.html) are never sortable because there is no real data behind
// them.

const walletPerfState = { page: 1, pageSize: 100, sortBy: "score", direction: "DESC", q: "" };

function renderCategoryTabs(categories){

    const el = document.getElementById("ceoCategoryTabs");

    const allCategories = ["All", ...categories];

    el.innerHTML = allCategories.map(c => `<button data-category="${c}" class="${(activeWalletCategory||"All")===c?"active":""}">${c}</button>`).join("");

    el.querySelectorAll("button").forEach(btn => {

        btn.onclick = async () => {

            activeWalletCategory = btn.dataset.category === "All" ? null : btn.dataset.category;

            el.querySelectorAll("button").forEach(b => b.classList.remove("active"));

            btn.classList.add("active");

            walletPerfState.page = 1;

            await renderWalletPerformanceCeo(activeWalletCategory);

            renderExportButtons();

        };

    });

}

function shortAddr(addr){ return `${addr.slice(0,4)}...${addr.slice(-4)}`; }

const WALLET_PERF_SORT_HEADERS = [

    { key: "walletAddress", label: "Wallet" },
    null, // Category - not sortable (label text, not a ranked column)
    { key: "predictionCount", label: "Prediction Count" },
    null, null, null, null, // Strong BUY / BUY / HOLD / AVOID - n/a, not sortable
    { key: "tpCount", label: "TP" },
    { key: "slCount", label: "SL" },
    null, // Expired - n/a, not sortable
    { key: "openCount", label: "Open" },
    { key: "winRate", label: "Win Rate" },
    { key: "averageRoiPct", label: "Average ROI" },
    { key: "totalRealizedProfitUsd", label: "Total ROI (P&amp;L USD)" },
    { key: "averageHoldingSeconds", label: "Avg Holding Time" },
    { key: "score", label: "Score" },
    { key: "lastSeen", label: "Last Seen" }

];

function walletPerfHeaderCell(h){

    if(!h) return `<th></th>`;

    const active = walletPerfState.sortBy === h.key;

    const arrow = active ? (walletPerfState.direction === "ASC" ? " ▲" : " ▼") : "";

    return `<th data-sort="${h.key}" style="cursor:pointer;">${h.label}${arrow}</th>`;

}

async function renderWalletPerformanceCeo(category){

    const el = document.getElementById("ceoWalletPerformance");

    const pagerEl = document.getElementById("ceoWalletPerfPager");

    el.innerHTML = `<p class="adminNote">Loading...</p>`;

    const showAll = walletPerfState.pageSize === "all";

    const limit = showAll ? 5000 : walletPerfState.pageSize;

    const offset = showAll ? 0 : (walletPerfState.page - 1) * walletPerfState.pageSize;

    const params = { limit, offset, sortBy: walletPerfState.sortBy, direction: walletPerfState.direction };

    if(category) params.category = category;

    if(walletPerfState.q) params.q = walletPerfState.q;

    try{

        const data = await adminFetch(`/admin/ceo/wallet-performance${buildFilterParams(params)}`);

        if(!data.wallets.length){

            el.innerHTML = `<p class="adminNote">No data available${data.error ? ` - ${data.error}` : ""}.</p>`;

            pagerEl.innerHTML = "";

            return;

        }

        el.innerHTML = `
            <table class="adminTable">
                <thead><tr>
                    <th>Rank</th>
                    ${WALLET_PERF_SORT_HEADERS.map(walletPerfHeaderCell).join("")}
                </tr></thead>
                <tbody>
                ${data.wallets.map(w => `
                    <tr>
                        <td>${w.rank}</td>
                        <td>
                            <span class="adminWalletAddrLink" title="View wallet detail" data-detail="${w.walletAddress}">${shortAddr(w.walletAddress)}</span>
                            <div class="adminWalletRowActions">
                                <button class="adminActionBtn" data-copy="${w.walletAddress}" title="Copy full address">&#128203; Copy</button>
                                <a class="adminActionBtn" href="${solscanWalletLink(w.walletAddress)}" target="_blank" rel="noopener noreferrer" title="Open on Solscan">&#128279; Solscan</a>
                                <a class="adminActionBtn" href="${birdeyeWalletLink(w.walletAddress)}" target="_blank" rel="noopener noreferrer" title="Open on Birdeye">&#128279; Birdeye</a>
                                <a class="adminActionBtn" href="${gmgnWalletLink(w.walletAddress)}" target="_blank" rel="noopener noreferrer" title="Open on GMGN">&#128279; GMGN</a>
                            </div>
                        </td>
                        <td>${w.category}</td>
                        <td>${fmtNum(w.predictionCount)}</td>
                        <td title="No per-wallet link exists in this schema - see note above the table.">n/a</td>
                        <td title="No per-wallet link exists in this schema - see note above the table.">n/a</td>
                        <td title="No per-wallet link exists in this schema - see note above the table.">n/a</td>
                        <td title="No per-wallet link exists in this schema - see note above the table.">n/a</td>
                        <td>${fmtNum(w.tpCount)}</td>
                        <td>${fmtNum(w.slCount)}</td>
                        <td title="No per-wallet link exists in this schema - see note above the table.">n/a</td>
                        <td>${fmtNum(w.openCount)}</td>
                        <td>${fmtPct(w.winRate)}</td>
                        <td>${w.averageRoiPct!=null?w.averageRoiPct.toFixed(1)+"%":"-"}</td>
                        <td>$${fmtNum(w.totalRealizedProfitUsd, 2)}</td>
                        <td>${fmtDuration(w.averageHoldingSeconds)}</td>
                        <td>${fmtNum(w.score)}</td>
                        <td>${w.lastSeen || "-"}</td>
                    </tr>
                `).join("")}
                </tbody>
            </table>
        `;

        el.querySelectorAll("[data-copy]").forEach(btn => {

            btn.onclick = (e) => {

                e.stopPropagation();

                navigator.clipboard.writeText(btn.dataset.copy);

                const original = btn.textContent;

                btn.textContent = "Copied!";

                setTimeout(() => { btn.textContent = original; }, 1200);

            };

        });

        el.querySelectorAll("[data-detail]").forEach(span => {

            span.onclick = () => openWalletDetail(span.dataset.detail);

        });

        el.querySelectorAll("th[data-sort]").forEach(th => {

            th.onclick = async () => {

                const key = th.dataset.sort;

                if(walletPerfState.sortBy === key){

                    walletPerfState.direction = walletPerfState.direction === "ASC" ? "DESC" : "ASC";

                }
                else{

                    walletPerfState.sortBy = key;

                    walletPerfState.direction = "DESC";

                }

                await renderWalletPerformanceCeo(activeWalletCategory);

            };

        });

        const total = data.total ?? data.wallets.length;

        const shownFrom = offset + 1;

        const shownTo = offset + data.wallets.length;

        pagerEl.innerHTML = showAll
            ? `<span class="adminNote">Showing all ${fmtNum(total)} matching wallets (capped at 5,000 per request).</span>`
            : `
                <button class="adminActionBtn" id="ceoWalletPerfPrev" ${walletPerfState.page<=1?"disabled":""}>&laquo; Prev</button>
                <span class="adminNote">Showing ${fmtNum(shownFrom)}-${fmtNum(shownTo)} of ${fmtNum(total)}</span>
                <button class="adminActionBtn" id="ceoWalletPerfNext" ${shownTo>=total?"disabled":""}>Next &raquo;</button>
            `;

        if(!showAll){

            const prevBtn = document.getElementById("ceoWalletPerfPrev");

            const nextBtn = document.getElementById("ceoWalletPerfNext");

            if(prevBtn) prevBtn.onclick = async () => { walletPerfState.page = Math.max(1, walletPerfState.page - 1); await renderWalletPerformanceCeo(activeWalletCategory); };

            if(nextBtn) nextBtn.onclick = async () => { walletPerfState.page = walletPerfState.page + 1; await renderWalletPerformanceCeo(activeWalletCategory); };

        }

        const exportEl = document.querySelector('.ceoExportBtns[data-section="wallet-performance"]');

        if(exportEl) exportEl.dataset.extra = JSON.stringify(category ? { category } : {});

    }
    catch(e){

        console.error(e);

        el.innerHTML = `<p class="adminNote">No data available.</p>`;

        pagerEl.innerHTML = "";

    }

}

document.getElementById("ceoWalletPerfSearchBtn").onclick = () => {

    walletPerfState.q = document.getElementById("ceoWalletPerfSearch").value.trim();

    walletPerfState.page = 1;

    renderWalletPerformanceCeo(activeWalletCategory);

};

document.getElementById("ceoWalletPerfSearch").addEventListener("keyup", (e) => { if(e.key === "Enter") document.getElementById("ceoWalletPerfSearchBtn").click(); });

document.getElementById("ceoWalletPerfPageSize").addEventListener("change", (e) => {

    walletPerfState.pageSize = e.target.value === "all" ? "all" : Number(e.target.value);

    walletPerfState.page = 1;

    renderWalletPerformanceCeo(activeWalletCategory);

});

// =====================================
// EXPORT (Admin V3 Section 10) - CSV + genuine XLSX on every table,
// wired onto any .ceoExportBtns[data-section] container present.
// =====================================

function exportUrl(section, format, extra = {}){

    const params = new URLSearchParams({ section, format, ...extra });

    if(predictionDateFilter.from) params.set("from", predictionDateFilter.from);

    if(predictionDateFilter.to) params.set("to", predictionDateFilter.to);

    return `${BASE_URL}/admin/ceo/export?${params.toString()}`;

}

async function downloadExport(url){

    const res = await fetch(url, { headers: { "X-Admin-Key": getAdminKey() } });

    if(!res.ok){ alert(`Export failed (HTTP ${res.status})`); return; }

    const blob = await res.blob();

    const disposition = res.headers.get("Content-Disposition") || "";

    const match = disposition.match(/filename="(.+)"/);

    const filename = match ? match[1] : "export";

    const link = document.createElement("a");

    link.href = URL.createObjectURL(blob);

    link.download = filename;

    document.body.appendChild(link);

    link.click();

    link.remove();

    URL.revokeObjectURL(link.href);

}

// Admin V3.1, Part 6 - one Export button (with a CSV/Excel dropdown)
// per section, replacing the previous two-button-per-section pattern
// repeated across all ~11 export containers.

function renderExportButtons(){

    document.querySelectorAll(".ceoExportBtns[data-section]").forEach(el => {

        const section = el.dataset.section;

        el.innerHTML = `
            <div class="adminExportDropdown">
                <button class="adminActionBtn" data-role="toggle">Export &#9662;</button>
                <div class="adminExportMenu hidden">
                    <button data-fmt="csv">Export CSV</button>
                    <button data-fmt="xlsx">Export Excel</button>
                </div>
            </div>
        `;

        const toggle = el.querySelector('[data-role="toggle"]');

        const menu = el.querySelector(".adminExportMenu");

        toggle.onclick = (e) => {

            e.stopPropagation();

            document.querySelectorAll(".adminExportMenu").forEach(m => { if(m !== menu) m.classList.add("hidden"); });

            menu.classList.toggle("hidden");

        };

        el.querySelectorAll("[data-fmt]").forEach(btn => {

            btn.onclick = (e) => {

                e.stopPropagation();

                menu.classList.add("hidden");

                downloadExport(exportUrl(section, btn.dataset.fmt, el.dataset.extra ? JSON.parse(el.dataset.extra) : {}));

            };

        });

    });

}

document.addEventListener("click", () => {

    document.querySelectorAll(".adminExportMenu").forEach(m => m.classList.add("hidden"));

});

// Re-fetches ONLY the Prediction Validation summary/strong-buy/
// statistics and the Analytics wallet rankings - never the whole
// page - with the current date filter applied to every one of them.
// This is what both the Apply button and the Quick buttons call.

// The ONE function every global-date-filter interaction calls
// (Apply button, quick buttons, wallet category tabs indirectly) -
// refreshes every section that depends on the shared filter: Result
// Summary, Signal Summary, Strong Buy, Failure Analysis, Confidence
// Calibration, Wallet Performance, AI Engine Advisor, and the legacy
// Analytics leaderboards. Never touches System/Token/Engine Config/
// Engine Evolution, which don't depend on the date filter.

async function loadPredictionAndAnalytics(){

    updateActiveFilterLabel();

    const scrollY = window.scrollY;

    // Every fetch below is isolated the same way as loadAll() (Parts
    // 1-3) - one failing endpoint only blanks its own container with
    // "No data available", never any sibling section.

    await Promise.all([

        loadOne(publicFetch(`/validation/predictions/summary${buildFilterParams()}`), renderPredValidationSummary, () => noData("predValidationSummary")),

        loadOne(publicFetch(`/validation/predictions/strong-buy${buildFilterParams()}`), renderStrongBuyCeo, () => noData("ceoStrongBuy")),

        loadOne(publicFetch(`/validation/predictions/statistics${buildFilterParams()}`), renderFailureAnalysisCeo, () => {

            noData("ceoFailureHeadlines"); noData("ceoFailureReasons"); noData("ceoWinningReasons");
            noData("ceoWalletCategoryLosses"); noData("ceoTokenPatternLosses"); noData("ceoConfidenceCalibration");

        }),

        loadOne(adminFetch(`/admin/ceo/signal-summary${buildFilterParams()}`), renderSignalSummary, () => noData("ceoSignalSummary")),

        loadOne(adminFetch(`/admin/ceo/ai-health${buildFilterParams()}`), renderAiHealth, () => setElsText(AI_HEALTH_STAT_IDS, "N/A")),

        loadOne(adminFetch("/admin/ceo/wallet-categories"), d => renderCategoryTabs(d.categories), () => noData("ceoCategoryTabs"))

    ]);

    await renderWalletPerformanceCeo(activeWalletCategory);

    await loadEngineAdvisor();

    lastLegacyPredictions = await adminFetch("/admin/predictions/summary").catch(() => ({ horizons: [] }));

    await renderAnalytics(lastLegacyPredictions);

    renderExportButtons();

    if(window.scrollY !== scrollY) window.scrollTo(0, scrollY);

}

let lastLegacyPredictions = { horizons: [] };

document.getElementById("analyticsSearchBtn").onclick = () => {

    analyticsState.q = document.getElementById("analyticsSearchInput").value.trim();

    renderAnalytics(lastLegacyPredictions);

};

document.getElementById("analyticsSearchInput").addEventListener("keyup", (e) => { if(e.key === "Enter") document.getElementById("analyticsSearchBtn").click(); });

document.getElementById("analyticsLimitSelect").addEventListener("change", (e) => {

    analyticsState.limit = Number(e.target.value);

    renderAnalytics(lastLegacyPredictions);

});

// Filter UI wiring - quick buttons compute a real UTC date range and
// mirror it into the Start/End inputs; the Apply button reads
// whatever is currently in those two inputs (so manually-typed dates
// work too, not just the quick presets).

document.getElementById("predFilterApplyBtn").onclick = () => {

    predictionDateFilter = {

        from: document.getElementById("predFilterFrom").value || undefined,

        to: document.getElementById("predFilterTo").value || undefined

    };

    document.querySelectorAll(".adminDateFilterQuick .adminActionBtn").forEach(b => b.classList.remove("active"));

    walletPerfState.page = 1;

    loadPredictionAndAnalytics();

};

document.querySelectorAll(".adminDateFilterQuick .adminActionBtn[data-quick]").forEach(btn => {

    btn.onclick = () => {

        const range = computeQuickRange(btn.dataset.quick);

        predictionDateFilter = range;

        document.getElementById("predFilterFrom").value = range.from || "";

        document.getElementById("predFilterTo").value = range.to || "";

        document.querySelectorAll(".adminDateFilterQuick .adminActionBtn").forEach(b => b.classList.remove("active"));

        btn.classList.add("active");

        walletPerfState.page = 1;

        loadPredictionAndAnalytics();

    };

});

function renderPredictions(p){

    const summaryRows = `
        <div class="adminGrid4">
            <div class="adminStat"><span>Prediction Count</span><strong>${fmtNum(p.totalRecommendationsLogged)}</strong></div>
            <div class="adminStat"><span>Outcomes Evaluated</span><strong>${fmtNum(p.totalOutcomesEvaluated)}</strong></div>
            <div class="adminStat"><span>Min Sample Size</span><strong>${p.minSampleSizeForMetrics}</strong></div>
            <div class="adminStat"><span>Win Definition</span><strong>BUY&gt;${p.winDefinition.buyMinReturnPct}% / HOLD&gt;${p.winDefinition.holdMinReturnPct}% / AVOID&le;${p.winDefinition.avoidMaxReturnPct}%</strong></div>
        </div>
    `;

    const horizonRows = p.horizons.map(h => {

        const acc = h.accuracyByAction || {};

        return `
            <tr>
                <td>${h.horizon}</td>
                <td>${fmtNum(h.sampleSize)}</td>
                <td>${h.winRate != null ? fmtPct(h.winRate) : "n/a (sample too small)"}</td>
                <td>${h.averageReturnPct != null ? h.averageReturnPct.toFixed(2)+"%" : "-"}</td>
                <td>${acc.strongBuy?.accuracy != null ? fmtPct(acc.strongBuy.accuracy) : "-"} (n=${acc.strongBuy?.sampleSize||0})</td>
                <td>${acc.buy?.accuracy != null ? fmtPct(acc.buy.accuracy) : "-"} (n=${acc.buy?.sampleSize||0})</td>
                <td>${acc.hold?.accuracy != null ? fmtPct(acc.hold.accuracy) : "-"} (n=${acc.hold?.sampleSize||0})</td>
                <td>${acc.avoid?.accuracy != null ? fmtPct(acc.avoid.accuracy) : "-"} (n=${acc.avoid?.sampleSize||0})</td>
                <td>${h.confusionCounts?.falsePositive ?? "-"}</td>
                <td>${h.confusionCounts?.falseNegative ?? "-"}</td>
            </tr>
        `;

    }).join("");

    const table = `
        <div class="adminTableWrap">
            <table class="adminTable">
                <caption>Per-Horizon Real Outcomes (False BUY = predicted BUY-tier but price didn't rise; Missed BUY = predicted HOLD/AVOID but price rose)</caption>
                <thead>
                    <tr>
                        <th>Horizon</th><th>Sample</th><th>Win Rate</th><th>Avg Return</th>
                        <th>STRONG BUY Acc.</th><th>BUY Acc.</th><th>HOLD Acc.</th><th>AVOID Acc.</th>
                        <th>False BUY</th><th>Missed BUY</th>
                    </tr>
                </thead>
                <tbody>${horizonRows}</tbody>
            </table>
        </div>
    `;

    document.getElementById("predictionSummary").innerHTML = summaryRows + table;

}

// =====================================
// ADMIN ANALYTICS
// =====================================

// Admin V3.1, Part 11 - "should display ALL DATA, do NOT limit to Top
// 10". Every leaderboard below now reads a real, selectable row count
// (10/25/50/100 - MAX_LIMIT on the backend's /wallets/* routes is 200,
// see server/src/utils/validators.js) and a real address search (`q`,
// the same server-side substring match Wallet Performance uses),
// instead of the old hardcoded limit:10 + client-side .slice(0,10).
// This does not (yet) add full per-column sort/pagination the way
// Wallet Performance got in Part 5 - a deliberate, disclosed scope
// choice given seven leaderboards would each need their own paging
// state; search + a real row-count selector covers most of Part 11's
// ask without that added complexity.

const analyticsState = { limit: 25, q: "" };

async function walletTable(title, path, params = {}){

    try{

        const data = await publicFetch(`${path}${buildFilterParams({ ...params, limit: analyticsState.limit, q: analyticsState.q || undefined })}`);

        const wallets = data.wallets || [];

        if(!wallets.length) return `<div class="adminAnalyticsGroup"><h4>${title}</h4><p class="adminNote">No data available.</p></div>`;

        const rows = wallets.map(w => `
            <tr>
                <td><span title="${w.wallet_address}">${w.wallet_address.slice(0,4)}...${w.wallet_address.slice(-4)}</span></td>
                <td>${w.primary_label || "-"}</td>
                <td>${fmtNum(w.score)}</td>
                <td>${fmtPct(w.win_rate)}</td>
                <td>${fmtNum(w.avg_roi_pct,1)}%</td>
                <td>${fmtNum(w.total_trades)}</td>
            </tr>
        `).join("");

        return `
            <div class="adminAnalyticsGroup">
                <div class="adminTableWrap">
                    <table class="adminTable">
                        <caption>${title} (${wallets.length} shown)</caption>
                        <thead><tr><th>Wallet</th><th>Label</th><th>Score</th><th>Win Rate</th><th>Avg ROI</th><th>Trades</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        `;

    }
    catch(e){

        console.error(e);

        return `<div class="adminAnalyticsGroup"><h4>${title}</h4><p class="adminNote">No data available.</p></div>`;

    }

}

async function renderAnalytics(predictions){

    const el = document.getElementById("analyticsGroups");

    // Only show the "loading" placeholder on the very first render -
    // a filter change (or any later re-render) keeps the previous
    // tables visible until the new ones are ready, then swaps once,
    // instead of blanking the section on every date-filter click.

    if(!el.dataset.loadedOnce) el.innerHTML = `<p class="adminNote">Loading leaderboards...</p>`;

    const [topWallet, topRoi, topWinRate, topTrader, topSmartMoney, topKol, topSniper] = await Promise.all([

        walletTable("Top Wallet (by Score)", "/wallets/leaderboard", { sort: "score" }),

        walletTable("Top ROI", "/wallets/leaderboard", { sort: "avg_roi_pct" }),

        walletTable("Top Win Rate", "/wallets/leaderboard", { sort: "win_rate" }),

        walletTable("Top Trader", "/wallets/search", { label: "Trader" }),

        walletTable("Top Smart Money", "/wallets/search", { label: "Smart Money" }),

        walletTable("Top KOL", "/wallets/search", { label: "KOL Trader" }),

        walletTable("Top Sniper", "/wallets/search", { label: "Sniper" })

    ]);

    el.dataset.loadedOnce = "1";

    // "Top Prediction" - there is no separate leaderboard entity for
    // this (a recommendation is not a wallet); the honest, real
    // mapping is the same per-action accuracy breakdown already shown
    // in the Prediction section above, cross-referenced here rather
    // than invented as a new leaderboard that doesn't exist.

    const bestHorizon = predictions.horizons.find(h => h.winRate != null) || predictions.horizons[0];

    const topPredictionHtml = `
        <div class="adminAnalyticsGroup">
            <h4>Top Prediction (real accuracy, not a wallet leaderboard)</h4>
            <p class="adminNote">"Top Prediction" has no separate identity in this engine - shown here is the real per-action accuracy at the ${bestHorizon?.horizon || "shortest"} horizon, the same data as the Prediction section.</p>
            <div class="adminGrid4">
                <div class="adminStat"><span>STRONG BUY Accuracy</span><strong>${bestHorizon?.accuracyByAction?.strongBuy?.accuracy != null ? fmtPct(bestHorizon.accuracyByAction.strongBuy.accuracy) : "n/a"}</strong></div>
                <div class="adminStat"><span>BUY Accuracy</span><strong>${bestHorizon?.accuracyByAction?.buy?.accuracy != null ? fmtPct(bestHorizon.accuracyByAction.buy.accuracy) : "n/a"}</strong></div>
                <div class="adminStat"><span>HOLD Accuracy</span><strong>${bestHorizon?.accuracyByAction?.hold?.accuracy != null ? fmtPct(bestHorizon.accuracyByAction.hold.accuracy) : "n/a"}</strong></div>
                <div class="adminStat"><span>AVOID Accuracy</span><strong>${bestHorizon?.accuracyByAction?.avoid?.accuracy != null ? fmtPct(bestHorizon.accuracyByAction.avoid.accuracy) : "n/a"}</strong></div>
            </div>
        </div>
    `;

    el.innerHTML = topWallet + topRoi + topWinRate + topTrader + topSmartMoney + topKol + topSniper + topPredictionHtml;

}
