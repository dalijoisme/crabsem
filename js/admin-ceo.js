// =====================================
// CRAB AGENT - CEO DASHBOARD (Admin Dashboard V2)
//
// Business-facing view: is the engine improving, are predictions
// making money, which wallets perform best, what to improve next.
// Talks to /api/v1/admin/ceo/* (see server/src/controllers/
// ceoDashboardController.js) - a separate backend namespace from the
// engineering-focused /api/v1/admin/* used by admin.html/js/admin.js,
// though both share the same login (same X-Admin-Key session token,
// same sessionStorage key, so logging in on one page carries over to
// the other in the same browser tab).
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
const adminLogoutBtn = document.getElementById("adminLogoutBtn");
const adminLiveDot = document.getElementById("adminLiveDot");
const adminLiveText = document.getElementById("adminLiveText");

// =====================================
// AUTH (identical flow to js/admin.js)
// =====================================

function getAdminKey(){

    return sessionStorage.getItem(ADMIN_KEY_STORAGE) || "";

}

async function adminFetch(path){

    const res = await fetch(`${BASE_URL}${path}`, { headers: { "X-Admin-Key": getAdminKey() } });

    const json = await res.json().catch(() => null);

    if(res.status === 401){

        sessionStorage.removeItem(ADMIN_KEY_STORAGE);

        showGate("Session expired or incorrect password - please log in again.");

        throw new Error("Unauthorized");

    }

    if(!json || !json.success) throw new Error(json?.error || `Request failed (HTTP ${res.status})`);

    return json.data;

}

function showGate(message){

    adminGate.style.display = "flex";

    adminApp.classList.add("hidden");

    if(message) adminGateError.textContent = message;

}

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

        if(res.status === 401){ adminGateError.textContent = "Incorrect password."; return; }

        if(res.status === 503){ adminGateError.textContent = "Admin panel is not configured on the backend (ADMIN_PASSWORD unset)."; return; }

        if(!res.ok || !json?.success || !json.data?.token){ adminGateError.textContent = `Unexpected error (HTTP ${res.status}).`; return; }

        sessionStorage.setItem(ADMIN_KEY_STORAGE, json.data.token);

        adminGate.style.display = "none";

        adminApp.classList.remove("hidden");

        adminPasswordInput.value = "";

        loadAll();

    }
    catch(e){ adminGateError.textContent = "Could not reach the backend - check your connection."; }
    finally{ adminLoginBtn.disabled = false; }

}

adminLoginBtn.onclick = attemptLogin;

adminPasswordInput.addEventListener("keyup", (e) => { if(e.key === "Enter") attemptLogin(); });

adminLogoutBtn.onclick = () => { sessionStorage.removeItem(ADMIN_KEY_STORAGE); showGate(""); };

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

function fmtNum(n, digits = 0){

    if(n == null || isNaN(n)) return "-";

    return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });

}

function fmtPct(n, digits = 1){

    if(n == null || isNaN(n)) return "n/a";

    return (Number(n) * 100).toFixed(digits) + "%";

}

function fmtRoi(n, digits = 1){

    if(n == null || isNaN(n)) return "-";

    return Number(n).toFixed(digits) + "%";

}

function fmtDuration(seconds){

    if(seconds == null || isNaN(seconds)) return "-";

    if(seconds < 60) return `${Math.round(seconds)}s`;

    if(seconds < 3600) return `${Math.round(seconds/60)}m`;

    return `${(seconds/3600).toFixed(1)}h`;

}

function shortAddr(addr){

    return `${addr.slice(0,4)}...${addr.slice(-4)}`;

}

// =====================================
// SECTION 2 - GLOBAL DATE FILTER (shared by every section below)
// =====================================

let dateFilter = { from: undefined, to: undefined };

function toDateStr(d){ return d.toISOString().slice(0, 10); }

function daysAgoUTC(n){ const d = new Date(); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate()-n); return d; }

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

function buildFilterParams(extra = {}){

    const params = new URLSearchParams(extra);

    if(dateFilter.from) params.set("from", dateFilter.from);

    if(dateFilter.to) params.set("to", dateFilter.to);

    const qs = params.toString();

    return qs ? `?${qs}` : "";

}

function updateActiveFilterLabel(){

    const label = document.getElementById("ceoFilterActiveLabel");

    label.textContent = (dateFilter.from || dateFilter.to)

        ? `Showing: ${dateFilter.from || "…"} to ${dateFilter.to || "…"} - every card below reflects this range.`

        : "Showing: All Time - every card below updates from this one filter.";

}

document.getElementById("ceoFilterApplyBtn").onclick = () => {

    dateFilter = {

        from: document.getElementById("ceoFilterFrom").value || undefined,

        to: document.getElementById("ceoFilterTo").value || undefined

    };

    document.querySelectorAll(".adminDateFilterQuick .adminActionBtn").forEach(b => b.classList.remove("active"));

    loadAll();

};

document.querySelectorAll(".adminDateFilterQuick .adminActionBtn[data-quick]").forEach(btn => {

    btn.onclick = () => {

        const range = computeQuickRange(btn.dataset.quick);

        dateFilter = range;

        document.getElementById("ceoFilterFrom").value = range.from || "";

        document.getElementById("ceoFilterTo").value = range.to || "";

        document.querySelectorAll(".adminDateFilterQuick .adminActionBtn").forEach(b => b.classList.remove("active"));

        btn.classList.add("active");

        loadAll();

    };

});

// =====================================
// SECTION 10 - EXPORT BUTTONS (wired onto every .ceoExportBtns
// container by section name via its data-section attribute)
// =====================================

function exportUrl(section, format, extra = {}){

    const params = new URLSearchParams({ section, format, ...extra });

    if(dateFilter.from) params.set("from", dateFilter.from);

    if(dateFilter.to) params.set("to", dateFilter.to);

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

function renderExportButtons(extra = {}){

    document.querySelectorAll(".ceoExportBtns[data-section]").forEach(el => {

        const section = el.dataset.section;

        el.innerHTML = `
            <button class="adminActionBtn" data-fmt="csv">Export CSV</button>
            <button class="adminActionBtn" data-fmt="xlsx">Export Excel</button>
        `;

        el.querySelectorAll("button").forEach(btn => {

            btn.onclick = () => downloadExport(exportUrl(section, btn.dataset.fmt, el.dataset.extra ? JSON.parse(el.dataset.extra) : extra));

        });

    });

}

// =====================================
// MAIN LOAD CYCLE
// =====================================

let activeCategory = null;

async function loadAll(){

    adminLoading.classList.remove("hidden");

    adminContent.classList.add("hidden");

    updateActiveFilterLabel();

    try{

        const [status, signal, result, categories, strongBuy, failure, recommendations, history] = await Promise.all([

            adminFetch("/admin/ceo/engine-status"),

            adminFetch(`/admin/ceo/signal-summary${buildFilterParams()}`),

            adminFetch(`/admin/ceo/result-summary${buildFilterParams()}`),

            adminFetch("/admin/ceo/wallet-categories"),

            adminFetch(`/admin/ceo/strong-buy${buildFilterParams()}`),

            adminFetch(`/admin/ceo/failure-analysis${buildFilterParams()}`),

            adminFetch(`/admin/ceo/recommendations${buildFilterParams()}`),

            adminFetch("/admin/ceo/engine-history")

        ]);

        renderEngineStatus(status);

        renderSignalSummary(signal);

        renderResultSummary(result);

        renderCategoryTabs(categories.categories);

        await renderWalletPerformance(activeCategory);

        renderStrongBuy(strongBuy);

        renderFailureAnalysis(failure);

        renderRecommendations(recommendations);

        renderEngineHistory(history.history);

        renderExportButtons();

        adminLiveDot.className = "live-dot " + (status.predictionEngineStatus === "ok" ? "ok" : "limited");

        adminLiveText.textContent = status.predictionEngineStatus === "ok" ? "LIVE" : "LIMITED";

    }
    catch(e){

        console.error("CEO dashboard load failed", e);

    }
    finally{

        adminLoading.classList.add("hidden");

        adminContent.classList.remove("hidden");

    }

}

// =====================================
// SECTION 1 - ENGINE STATUS
// =====================================

function renderEngineStatus(s){

    const el = document.getElementById("ceoStatusRow");

    el.innerHTML = `
        <div class="adminStat"><span>Engine Version</span><strong>${s.engineVersion}</strong></div>
        <div class="adminStat"><span>AI Model Version</span><strong>${s.aiModelVersion}</strong></div>
        <div class="adminStat"><span>Prediction Engine</span><strong>${s.predictionEngineStatus.toUpperCase()}</strong></div>
        <div class="adminStat"><span>Validation Scheduler</span><strong>${s.validationSchedulerStatus.toUpperCase()}</strong></div>
        <div class="adminStat"><span>Database</span><strong>${s.databaseStatus}</strong></div>
        <div class="adminStat"><span>Version Notes</span><strong style="font-size:11px;font-weight:400;color:var(--muted);">${s.engineVersionNotes.slice(0,80)}...</strong></div>
    `;

}

// =====================================
// SECTION 3 - SIGNAL SUMMARY
// =====================================

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
            <span class="ceoSignalPct">${fmtPct(t.percentage)} of ${fmtNum(data.total)} total</span>
            ${trendHtml(t.trendCount, t.trendPct)}
        </div>
    `).join("");

}

// =====================================
// SECTION 4 - RESULT SUMMARY
// =====================================

function renderResultSummary(r){

    document.getElementById("ceoResultSummary").innerHTML = `
        <div class="adminStat"><span>Total Predictions</span><strong>${fmtNum(r.predictionCount)}</strong></div>
        <div class="adminStat"><span>TP Hit</span><strong>${fmtNum(r.tpCount)}</strong></div>
        <div class="adminStat"><span>SL Hit</span><strong>${fmtNum(r.slCount)}</strong></div>
        <div class="adminStat"><span>Expired</span><strong>${fmtNum(r.expiredCount)}</strong></div>
        <div class="adminStat"><span>Still Open</span><strong>${fmtNum(r.openCount)}</strong></div>
        <div class="adminStat"><span>Win Rate</span><strong>${fmtPct(r.winRate)}</strong></div>
        <div class="adminStat"><span>Average ROI</span><strong>${fmtRoi(r.averageRoiPct)}</strong></div>
        <div class="adminStat"><span>Median ROI</span><strong>${fmtRoi(r.medianRoiPct)}</strong></div>
        <div class="adminStat"><span>Largest Winner</span><strong>${fmtRoi(r.largestWinnerPct)}</strong></div>
        <div class="adminStat"><span>Largest Loser</span><strong>${fmtRoi(r.largestLoserPct)}</strong></div>
        <div class="adminStat"><span>Avg Time to TP</span><strong>${fmtDuration(r.averageTimeToTpSeconds)}</strong></div>
        <div class="adminStat"><span>Avg Time to SL</span><strong>${fmtDuration(r.averageTimeToSlSeconds)}</strong></div>
    `;

}

// =====================================
// SECTION 5 - WALLET PERFORMANCE
// =====================================

function renderCategoryTabs(categories){

    const el = document.getElementById("ceoCategoryTabs");

    const allCategories = ["All", ...categories];

    el.innerHTML = allCategories.map(c => `<button data-category="${c}" class="${(activeCategory||"All")===c?"active":""}">${c}</button>`).join("");

    el.querySelectorAll("button").forEach(btn => {

        btn.onclick = async () => {

            activeCategory = btn.dataset.category === "All" ? null : btn.dataset.category;

            el.querySelectorAll("button").forEach(b => b.classList.remove("active"));

            btn.classList.add("active");

            await renderWalletPerformance(activeCategory);

            renderExportButtons();

        };

    });

}

async function renderWalletPerformance(category){

    const el = document.getElementById("ceoWalletPerformance");

    el.innerHTML = `<p class="adminNote">Loading...</p>`;

    try{

        const data = await adminFetch(`/admin/ceo/wallet-performance${buildFilterParams(category ? { category, limit: 20 } : { limit: 20 })}`);

        if(!data.wallets.length){

            el.innerHTML = `<p class="adminNote">No wallets found for this category/period${data.error ? ` - ${data.error}` : ""}.</p>`;

            return;

        }

        el.innerHTML = `
            <table class="adminTable">
                <thead><tr>
                    <th>Rank</th><th>Wallet</th><th>Category</th><th>Prediction Count</th>
                    <th>Win Rate</th><th>Average ROI</th><th>Total P&amp;L (USD)</th>
                    <th>TP</th><th>SL</th><th>Open</th>
                </tr></thead>
                <tbody>
                ${data.wallets.map(w => `
                    <tr>
                        <td>${w.rank}</td>
                        <td><span title="${w.walletAddress}">${shortAddr(w.walletAddress)}</span>
                            <button class="adminActionBtn" style="padding:2px 6px;font-size:10px;" onclick="navigator.clipboard.writeText('${w.walletAddress}')">Copy</button>
                        </td>
                        <td>${w.category}</td>
                        <td>${fmtNum(w.predictionCount)}</td>
                        <td>${fmtPct(w.winRate)}</td>
                        <td>${fmtRoi(w.averageRoiPct)}</td>
                        <td>$${fmtNum(w.totalRealizedProfitUsd, 2)}</td>
                        <td>${fmtNum(w.tpCount)}</td>
                        <td>${fmtNum(w.slCount)}</td>
                        <td>${fmtNum(w.openCount)}</td>
                    </tr>
                `).join("")}
                </tbody>
            </table>
        `;

        const exportEl = document.querySelector('.ceoExportBtns[data-section="wallet-performance"]');

        if(exportEl) exportEl.dataset.extra = JSON.stringify(category ? { category, limit: 20 } : { limit: 20 });

    }
    catch(e){

        el.innerHTML = `<p class="adminNote">Failed to load: ${e.message}</p>`;

    }

}

// =====================================
// SECTION 6 - STRONG BUY ANALYSIS
// =====================================

function renderStrongBuy(s){

    document.getElementById("ceoStrongBuy").innerHTML = `
        <div class="adminStat"><span>Issued</span><strong>${fmtNum(s.predictionCount)}</strong></div>
        <div class="adminStat"><span>TP</span><strong>${fmtNum(s.tpCount)}</strong></div>
        <div class="adminStat"><span>SL</span><strong>${fmtNum(s.slCount)}</strong></div>
        <div class="adminStat"><span>Expired</span><strong>${fmtNum(s.expiredCount)}</strong></div>
        <div class="adminStat"><span>Open</span><strong>${fmtNum(s.openCount)}</strong></div>
        <div class="adminStat"><span>Win Rate</span><strong>${fmtPct(s.winRate)}</strong></div>
        <div class="adminStat"><span>Average ROI</span><strong>${fmtRoi(s.averageRoiPct)}</strong></div>
        <div class="adminStat"><span>Avg Time to TP</span><strong>${fmtDuration(s.averageTimeToTpSeconds)}</strong></div>
    `;

}

// =====================================
// SECTION 7 - FAILURE ANALYSIS
// =====================================

function barRow(label, count, max){

    const pct = max > 0 ? Math.min(100, (count/max)*100) : 0;

    return `
        <div class="adminBarRow">
            <div class="adminBarLabel"><span>${label}</span><strong>${count}</strong></div>
            <div class="adminBarTrack"><div class="adminBarFill" style="width:${pct}%"></div></div>
        </div>
    `;

}

function renderFailureAnalysis(f){

    document.getElementById("ceoFailureHeadlines").innerHTML = `
        <div class="ceoSignalCard avoid">
            <span class="ceoSignalLabel">Most Common Losing Reason</span>
            <span class="ceoSignalCount" style="font-size:18px;">${f.mostCommonLosingReason ? f.mostCommonLosingReason.reason : "n/a"}</span>
            <span class="ceoSignalPct">${f.mostCommonLosingReason ? fmtNum(f.mostCommonLosingReason.count) + " occurrences" : "No losses in this period yet"}</span>
        </div>
        <div class="ceoSignalCard strongbuy">
            <span class="ceoSignalLabel">Most Common Winning Reason</span>
            <span class="ceoSignalCount" style="font-size:18px;">${f.mostCommonWinningReason ? f.mostCommonWinningReason.reason : "n/a"}</span>
            <span class="ceoSignalPct">${f.mostCommonWinningReason ? fmtNum(f.mostCommonWinningReason.count) + " occurrences" : "No wins recorded with a reason yet"}</span>
        </div>
        <div class="ceoSignalCard buy">
            <span class="ceoSignalLabel">False BUY</span>
            <span class="ceoSignalCount">${fmtNum(f.falseBuyCount)}</span>
            <span class="ceoSignalPct">STRONG BUY/BUY predictions that didn't hit target</span>
        </div>
        <div class="ceoSignalCard hold">
            <span class="ceoSignalLabel">Missed BUY</span>
            <span class="ceoSignalCount">${fmtNum(f.missedBuyCount)}</span>
            <span class="ceoSignalPct">HOLD predictions that would have hit target anyway</span>
        </div>
    `;

    const maxFailure = Math.max(1, ...f.failureAnalysis.map(r => r.count));

    document.getElementById("ceoFailureReasons").innerHTML = f.failureAnalysis.length

        ? f.failureAnalysis.map(r => barRow(r.reason, r.count, maxFailure)).join("")

        : `<p class="adminNote">No losing predictions in this period yet.</p>`;

    const maxWin = Math.max(1, ...f.winAnalysis.map(r => r.count));

    document.getElementById("ceoWinningReasons").innerHTML = f.winAnalysis.length

        ? f.winAnalysis.map(r => barRow(r.reason, r.count, maxWin)).join("")

        : `<p class="adminNote">No TP-hit predictions with a recorded reason in this period yet (older TP closures predate this analysis - see final report).</p>`;

    const maxCat = Math.max(1, ...f.walletCategoryLosses.map(r => r.count));

    document.getElementById("ceoWalletCategoryLosses").innerHTML = f.walletCategoryLosses.length

        ? f.walletCategoryLosses.map(r => barRow(r.category, r.count, maxCat)).join("")

        : `<p class="adminNote">No losing predictions in this period yet.</p>`;

    const maxPattern = Math.max(1, ...f.tokenPatternLosses.map(r => r.count));

    document.getElementById("ceoTokenPatternLosses").innerHTML = f.tokenPatternLosses.length

        ? f.tokenPatternLosses.map(r => barRow(r.pattern, r.count, maxPattern)).join("")

        : `<p class="adminNote">No losing predictions in this period yet.</p>`;

}

// =====================================
// SECTION 8 - AI RECOMMENDATIONS
// =====================================

function renderRecommendations(r){

    const el = document.getElementById("ceoRecommendations");

    if(!r.insights.length){

        el.innerHTML = `<p class="adminNote">No rule crossed its real threshold for this period yet - nothing to recommend.</p>`;

        return;

    }

    const warning = r.sampleWarning ? `<p class="adminNote">${r.sampleWarning}</p>` : "";

    el.innerHTML = warning + r.insights.map(i => `
        <div class="ceoInsightCard">
            <span class="ceoImpactBadge ${i.estimatedImpact.toLowerCase()}">${i.estimatedImpact} Impact</span>
            <span class="ceoInsightMessage">${i.message}</span>
        </div>
    `).join("");

}

// =====================================
// SECTION 9 - ENGINE IMPROVEMENT HISTORY
// =====================================

function renderEngineHistory(history){

    const el = document.getElementById("ceoEngineHistory");

    if(!history.length){ el.innerHTML = `<p class="adminNote">No version recorded yet.</p>`; return; }

    el.innerHTML = `
        <table class="adminTable">
            <thead><tr>
                <th>Version</th><th>Deployed</th><th>Win Rate</th><th>Avg ROI</th>
                <th>Predictions</th><th>Win Rate Δ</th><th>Avg ROI Δ</th>
            </tr></thead>
            <tbody>
            ${history.map(v => `
                <tr>
                    <td>${v.version}</td>
                    <td>${v.deployedAt}</td>
                    <td>${fmtPct(v.winRate)}</td>
                    <td>${fmtRoi(v.averageRoiPct)}</td>
                    <td>${fmtNum(v.predictionCount)}</td>
                    <td>${v.winRateDelta != null ? fmtPct(v.winRateDelta) : "n/a (first version)"}</td>
                    <td>${v.averageRoiDelta != null ? fmtRoi(v.averageRoiDelta) : "n/a (first version)"}</td>
                </tr>
            `).join("")}
            </tbody>
        </table>
    `;

}
