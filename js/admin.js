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

async function loadAll(){

    const isFirstLoad = !adminFirstLoadDone;

    if(isFirstLoad){

        adminLoading.classList.remove("hidden");

        adminContent.classList.add("hidden");

    }

    const scrollY = window.scrollY;

    try{

        const [dashboard, system, wallets, engineConfig, predictions, engineStatus, engineHistory] = await Promise.all([

            adminFetch("/admin/dashboard"),

            adminFetch("/admin/system"),

            adminFetch("/admin/wallets/summary"),

            adminFetch("/admin/engine/config"),

            adminFetch("/admin/predictions/summary"),

            adminFetch("/admin/ceo/engine-status"),

            adminFetch("/admin/ceo/engine-history")

        ]);

        renderDashboard(dashboard);

        renderSystem(system);

        renderWallets(wallets);

        renderEngineConfig(engineConfig);

        renderPredictions(predictions);

        renderEngineStatus(engineStatus);

        renderEngineHistory(engineHistory.history);

        await loadPredictionAndAnalytics();

        adminLiveDot.className = "live-dot " + (system.engineStatus === "ok" ? "ok" : "limited");

        adminLiveText.textContent = system.engineStatus === "ok" ? "LIVE" : "LIMITED";

    }
    catch(e){

        console.error("Admin load failed", e);

    }
    finally{

        adminFirstLoadDone = true;

        adminLoading.classList.add("hidden");

        adminContent.classList.remove("hidden");

        if(window.scrollY !== scrollY) window.scrollTo(0, scrollY);

    }

}

// =====================================
// DASHBOARD (the minimal login-landing cards this sprint asked for)
// =====================================

function renderDashboard(d){

    document.getElementById("dashEngineStatus").textContent = d.engineStatus.toUpperCase();

    document.getElementById("dashScheduler").textContent = d.scheduler.gmgn.status.toUpperCase();

    document.getElementById("dashDatabase").textContent = d.database.connected ? "Connected" : "Disconnected";

    document.getElementById("dashPredictionCount").textContent = fmtNum(d.predictionCount);

    document.getElementById("dashStrongBuyCount").textContent = fmtNum(d.strongBuyCount);

    const v = d.validationSummary;

    document.getElementById("dashWinRate").textContent = v.winRate != null ? fmtPct(v.winRate) : "n/a";

    document.getElementById("dashTpCount").textContent = fmtNum(v.tpCount);

    document.getElementById("dashSlCount").textContent = fmtNum(v.slCount);

    document.getElementById("dashOpenCount").textContent = fmtNum(v.openCount);

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
            </div>
        `;

    }
    catch(e){

        resultEl.innerHTML = `<p class="adminNote">No tracked wallet found at this address.</p>`;

    }

};

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

        resultEl.innerHTML = `<p class="adminNote">Search failed: ${e.message}</p>`;

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
// AI ENGINE ADVISOR (Admin V3 Section 8)
// =====================================

async function loadEngineAdvisor(){

    const el = document.getElementById("ceoEngineAdvisor");

    try{

        const data = await adminFetch(`/admin/ceo/engine-advisor${buildFilterParams()}`);

        if(!data.advisories.length){

            el.innerHTML = `<p class="adminNote">No rule crossed its real threshold for this period yet - nothing to recommend.</p>`;

            return;

        }

        const warning = data.sampleWarning ? `<p class="adminNote">${data.sampleWarning}</p>` : "";

        el.innerHTML = warning + data.advisories.map(a => `
            <div class="ceoInsightCard">
                <div class="ceoInsightCardHead">
                    <span class="ceoInsightMessage"><strong>${a.reason}</strong></span>
                    <span class="ceoImpactBadge ${a.confidence.toLowerCase()}">${a.confidence} Confidence</span>
                </div>
                <div class="ceoAdvisorGrid">
                    <div><span>Current Value</span>${a.currentValue ?? "n/a - no direct engine parameter"}</div>
                    <div><span>Recommended Value</span>${a.recommendedValue ?? "n/a"}</div>
                    <div style="grid-column:1/-1;"><span>Expected Improvement</span>${a.expectedImprovement ?? "Not quantifiable from current data"}</div>
                </div>
            </div>
        `).join("");

    }
    catch(e){

        el.innerHTML = `<p class="adminNote">Failed to load: ${e.message}</p>`;

    }

}

function renderEngineConfig(c){

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

function renderCategoryTabs(categories){

    const el = document.getElementById("ceoCategoryTabs");

    const allCategories = ["All", ...categories];

    el.innerHTML = allCategories.map(c => `<button data-category="${c}" class="${(activeWalletCategory||"All")===c?"active":""}">${c}</button>`).join("");

    el.querySelectorAll("button").forEach(btn => {

        btn.onclick = async () => {

            activeWalletCategory = btn.dataset.category === "All" ? null : btn.dataset.category;

            el.querySelectorAll("button").forEach(b => b.classList.remove("active"));

            btn.classList.add("active");

            await renderWalletPerformanceCeo(activeWalletCategory);

            renderExportButtons();

        };

    });

}

function shortAddr(addr){ return `${addr.slice(0,4)}...${addr.slice(-4)}`; }

async function renderWalletPerformanceCeo(category){

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
                    <th>TP</th><th>SL</th><th>Open</th>
                    <th>Win Rate</th><th>Average ROI</th><th>Total ROI (P&amp;L USD)</th>
                </tr></thead>
                <tbody>
                ${data.wallets.map(w => `
                    <tr>
                        <td>${w.rank}</td>
                        <td><span title="${w.walletAddress}">${shortAddr(w.walletAddress)}</span>
                            <button class="adminActionBtn" style="padding:2px 6px;font-size:10px;" data-copy="${w.walletAddress}">Copy</button>
                        </td>
                        <td>${w.category}</td>
                        <td>${fmtNum(w.predictionCount)}</td>
                        <td>${fmtNum(w.tpCount)}</td>
                        <td>${fmtNum(w.slCount)}</td>
                        <td>${fmtNum(w.openCount)}</td>
                        <td>${fmtPct(w.winRate)}</td>
                        <td>${w.averageRoiPct!=null?w.averageRoiPct.toFixed(1)+"%":"-"}</td>
                        <td>$${fmtNum(w.totalRealizedProfitUsd, 2)}</td>
                    </tr>
                `).join("")}
                </tbody>
            </table>
        `;

        el.querySelectorAll("[data-copy]").forEach(btn => {

            btn.onclick = () => {

                navigator.clipboard.writeText(btn.dataset.copy);

                const original = btn.textContent;

                btn.textContent = "Copied!";

                setTimeout(() => { btn.textContent = original; }, 1200);

            };

        });

        const exportEl = document.querySelector('.ceoExportBtns[data-section="wallet-performance"]');

        if(exportEl) exportEl.dataset.extra = JSON.stringify(category ? { category, limit: 20 } : { limit: 20 });

    }
    catch(e){

        el.innerHTML = `<p class="adminNote">Failed to load: ${e.message}</p>`;

    }

}

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

function renderExportButtons(){

    document.querySelectorAll(".ceoExportBtns[data-section]").forEach(el => {

        const section = el.dataset.section;

        el.innerHTML = `
            <button class="adminActionBtn" data-fmt="csv">Export CSV</button>
            <button class="adminActionBtn" data-fmt="xlsx">Export Excel</button>
        `;

        el.querySelectorAll("button").forEach(btn => {

            btn.onclick = () => downloadExport(exportUrl(section, btn.dataset.fmt, el.dataset.extra ? JSON.parse(el.dataset.extra) : {}));

        });

    });

}

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

    try{

        const [summary, strongBuy, statistics, signalSummary, categories] = await Promise.all([

            publicFetch(`/validation/predictions/summary${buildFilterParams()}`),

            publicFetch(`/validation/predictions/strong-buy${buildFilterParams()}`),

            publicFetch(`/validation/predictions/statistics${buildFilterParams()}`),

            adminFetch(`/admin/ceo/signal-summary${buildFilterParams()}`),

            adminFetch("/admin/ceo/wallet-categories")

        ]);

        renderPredValidationSummary(summary);

        renderStrongBuyCeo(strongBuy);

        renderFailureAnalysisCeo(statistics);

        renderSignalSummary(signalSummary);

        renderCategoryTabs(categories.categories);

        await renderWalletPerformanceCeo(activeWalletCategory);

    }
    catch(e){

        document.getElementById("predValidationSummary").innerHTML = `<p class="adminNote">Failed to load: ${e.message}</p>`;

    }

    await loadEngineAdvisor();

    const legacyPredictions = await adminFetch("/admin/predictions/summary").catch(() => ({ horizons: [] }));

    await renderAnalytics(legacyPredictions);

    renderExportButtons();

    if(window.scrollY !== scrollY) window.scrollTo(0, scrollY);

}

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

async function walletTable(title, path, params = {}){

    try{

        const data = await publicFetch(`${path}${buildFilterParams(params)}`);

        const wallets = data.wallets || [];

        if(!wallets.length) return `<div class="adminAnalyticsGroup"><h4>${title}</h4><p class="adminNote">No wallets meet the minimum trade count yet.</p></div>`;

        const rows = wallets.slice(0,10).map(w => `
            <tr>
                <td>${w.wallet_address.slice(0,4)}...${w.wallet_address.slice(-4)}</td>
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
                        <caption>${title}</caption>
                        <thead><tr><th>Wallet</th><th>Label</th><th>Score</th><th>Win Rate</th><th>Avg ROI</th><th>Trades</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        `;

    }
    catch(e){

        return `<div class="adminAnalyticsGroup"><h4>${title}</h4><p class="adminNote">Failed to load: ${e.message}</p></div>`;

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

        walletTable("Top Wallet (by Score)", "/wallets/leaderboard", { sort: "score", limit: 10 }),

        walletTable("Top ROI", "/wallets/leaderboard", { sort: "avg_roi_pct", limit: 10 }),

        walletTable("Top Win Rate", "/wallets/leaderboard", { sort: "win_rate", limit: 10 }),

        walletTable("Top Trader", "/wallets/search", { label: "Trader", limit: 10 }),

        walletTable("Top Smart Money", "/wallets/search", { label: "Smart Money", limit: 10 }),

        walletTable("Top KOL", "/wallets/search", { label: "KOL Trader", limit: 10 }),

        walletTable("Top Sniper", "/wallets/search", { label: "Sniper", limit: 10 })

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
