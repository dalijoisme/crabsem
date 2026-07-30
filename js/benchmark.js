// =====================================
// CRAB AGENT BENCHMARK HARNESS DASHBOARD
//
// Read-only observer/control panel over the Benchmark Harness Admin
// API (Benchmark Harness Architecture Design Document section 6/9).
// Reuses the exact same admin auth/session pattern as js/tradingBot.js
// (X-Admin-Key header, server-side check via adminAuth.js).
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
adminRefreshBtn.onclick = () => loadAll();

// =====================================
// FORMAT HELPERS
// =====================================

function fmtUsd(n){ return n == null ? "—" : `$${Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`; }
function fmtPct(n){ return n == null ? "—" : `${Number(n).toFixed(2)}%`; }
function fmtNum(n){ return n == null ? "—" : Number(n).toLocaleString(); }
function fmtDuration(seconds){
    if(seconds == null) return "—";
    const h = Math.floor(seconds/3600), m = Math.floor((seconds%3600)/60), s = Math.round(seconds%60);
    if(h > 0) return `${h}h ${m}m`;
    if(m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}
function noData(id){ document.getElementById(id).innerHTML = `<div class="tbEmptyState">No data available.</div>`; }

let selectedRunId = null;
let cachedProfiles = [];

// =====================================
// HEALTH
// =====================================

function renderHealth(h){
    const collectorStatus = h.collectorHealth?.every(c => c.healthy) ? "OK" : "DEGRADED";
    document.getElementById("bhHealth").innerHTML = `
        <div class="adminGrid4">
            <div class="adminStat"><span>Active Benchmark Runs</span><strong>${fmtNum(h.activeRuns)}</strong></div>
            <div class="adminStat"><span>Runtime</span><strong>${fmtDuration(h.uptimeSeconds)}</strong></div>
            <div class="adminStat"><span>Memory (RSS)</span><strong>${h.memory.rssMb.toFixed(1)} MB</strong></div>
            <div class="adminStat"><span>Memory (Heap Used)</span><strong>${h.memory.heapUsedMb.toFixed(1)} MB</strong></div>
            <div class="adminStat"><span>GMGN Collector</span><strong><span class="tbPill ${collectorStatus === "OK" ? "tbPos" : "tbNeg"}">${collectorStatus}</span></strong></div>
            <div class="adminStat"><span>Collector Tick</span><strong>${h.tickHealth.stuck ? "STUCK" : (h.tickHealth.isRunning ? "IN PROGRESS" : "IDLE")}</strong></div>
            <div class="adminStat"><span>Prediction Pipeline Health</span><strong>Not available - see architecture doc, no health instrumentation on predictionValidationScheduler yet</strong></div>
        </div>
    `;
}

async function loadHealth(){
    try{ renderHealth(await adminFetch("/benchmark/health")); }
    catch(e){ noData("bhHealth"); }
}

// =====================================
// PROFILES
// =====================================

function renderProfiles(profiles){
    cachedProfiles = profiles;

    document.getElementById("bhProfilesList").innerHTML = `
        <div class="bhProfileGrid">
            ${profiles.map(p => `
                <div class="bhProfileTile">
                    <div class="bhProfileName">${p.name}</div>
                    <div class="bhProfileDesc">${p.description || "—"}</div>
                </div>
            `).join("")}
        </div>
    `;

    document.getElementById("bhParticipantChoices").innerHTML = profiles.map(p => `
        <label class="bhChoice"><input type="checkbox" value="${p.name}" class="bhParticipantCheckbox"> ${p.name}</label>
    `).join("");
}

async function loadProfiles(){
    try{ renderProfiles(await adminFetch("/benchmark/profiles")); }
    catch(e){ noData("bhProfilesList"); }
}

document.getElementById("bhCreateProfileBtn").onclick = async () => {
    const msgEl = document.getElementById("bhProfileMsg");
    const name = document.getElementById("bhNewProfileName").value.trim();
    const description = document.getElementById("bhNewProfileDesc").value.trim();
    const configText = document.getElementById("bhNewProfileConfig").value.trim();
    let config;
    try{ config = JSON.parse(configText); }
    catch(e){ msgEl.textContent = "Config must be valid JSON."; msgEl.className = "tbControlMsg tbMsgError"; return; }
    try{
        await adminFetch("/benchmark/profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, description, config }) });
        msgEl.textContent = `Profile "${name}" created.`;
        msgEl.className = "tbControlMsg tbMsgOk";
        loadProfiles();
    }
    catch(e){
        msgEl.textContent = e.message || "Failed to create profile.";
        msgEl.className = "tbControlMsg tbMsgError";
    }
};

// =====================================
// START RUN
// =====================================

document.getElementById("bhStartRunBtn").onclick = async () => {
    const msgEl = document.getElementById("bhStartRunMsg");
    const name = document.getElementById("bhRunName").value.trim();
    const plannedDurationSeconds = Number(document.getElementById("bhRunDuration").value);
    const profileNames = [...document.querySelectorAll(".bhParticipantCheckbox:checked")].map(el => el.value);
    try{
        await adminFetch("/benchmark/runs/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, plannedDurationSeconds, profileNames }) });
        msgEl.textContent = "Benchmark started.";
        msgEl.className = "tbControlMsg tbMsgOk";
        loadRuns();
    }
    catch(e){
        msgEl.textContent = e.message || "Failed to start benchmark.";
        msgEl.className = "tbControlMsg tbMsgError";
    }
};

// =====================================
// RUNS LIST
// =====================================

function renderRuns(runs){
    const el = document.getElementById("bhRunsList");
    if(!runs.length){
        el.innerHTML = `<div class="tbEmptyState">No benchmark runs yet. Configure participants above and click Start Benchmark.</div>`;
        return;
    }
    el.innerHTML = runs.map(r => `
        <div class="bhRunCard">
            <div class="bhRunMeta">
                <div class="bhRunName">${r.name} <span class="bhStatusPill ${r.status}">${r.status}</span></div>
                <div class="bhRunSub">Duration: ${fmtDuration(r.planned_duration_seconds)} · Started: ${r.started_at || "—"}</div>
            </div>
            <div class="bhRunActions">
                <button class="tbBtn tbBtnStart bhViewBtn" data-run="${r.id}">View</button>
                ${r.status === "RUNNING" ? `<button class="tbBtn tbBtnPause bhPauseBtn" data-run="${r.id}">Pause</button>` : ""}
                ${r.status === "PAUSED" ? `<button class="tbBtn tbBtnStart bhResumeBtn" data-run="${r.id}">Resume</button>` : ""}
                ${["RUNNING","PAUSED"].includes(r.status) ? `<button class="tbBtn tbBtnEmergency bhStopBtn" data-run="${r.id}">Stop</button>` : ""}
            </div>
        </div>
    `).join("");

    el.querySelectorAll(".bhViewBtn").forEach(btn => btn.onclick = () => loadRunDetail(Number(btn.dataset.run)));
    el.querySelectorAll(".bhPauseBtn").forEach(btn => btn.onclick = async () => { await adminFetch(`/benchmark/runs/${btn.dataset.run}/pause`, { method: "POST" }); loadRuns(); });
    el.querySelectorAll(".bhResumeBtn").forEach(btn => btn.onclick = async () => { await adminFetch(`/benchmark/runs/${btn.dataset.run}/resume`, { method: "POST" }); loadRuns(); });
    el.querySelectorAll(".bhStopBtn").forEach(btn => btn.onclick = async () => {
        if(!confirm("Stop this benchmark? Open positions will be left as-is (not force-closed).")) return;
        await adminFetch(`/benchmark/runs/${btn.dataset.run}/stop`, { method: "POST" });
        loadRuns();
    });
}

async function loadRuns(){
    try{ renderRuns(await adminFetch("/benchmark/runs")); }
    catch(e){ noData("bhRunsList"); }
}

// =====================================
// RUN DETAIL - report (ranking), live positions, live equity
// =====================================

function renderRunDetail({ run, report, positions, statistics }){

    const reportRows = report.map(r => `
        <tr>
            <td><span class="bhRankBadge ${r.rank === 1 ? "first" : ""}">${r.rank}</span></td>
            <td>${r.profile_name}</td>
            <td>${fmtUsd(r.metrics.finalBalance)}</td>
            <td>${fmtUsd(r.metrics.netProfit)}</td>
            <td><span class="tbPill ${r.metrics.netReturnPct >= 0 ? "tbPos" : "tbNeg"}">${fmtPct(r.metrics.netReturnPct)}</span></td>
            <td>${fmtNum(r.metrics.totalTrades)}</td>
            <td>${r.metrics.winRatePct != null ? fmtPct(r.metrics.winRatePct) : "—"}</td>
            <td>${r.metrics.profitFactor != null ? r.metrics.profitFactor.toFixed(2) : "—"}</td>
            <td>${r.metrics.maxDrawdownPct != null ? fmtPct(r.metrics.maxDrawdownPct) : "—"}</td>
            <td>${r.metrics.recommendationAcceptanceRatePct != null ? fmtPct(r.metrics.recommendationAcceptanceRatePct) : "—"}</td>
            <td>${r.metrics.opportunityCapturePct != null ? fmtPct(r.metrics.opportunityCapturePct) : "—"}</td>
            <td>${r.metrics.averageSignalLatencySeconds != null ? fmtDuration(r.metrics.averageSignalLatencySeconds) : "—"}</td>
        </tr>
    `).join("");

    const positionRows = positions.map(p => `
        <tr>
            <td>${p.token_symbol || p.token_address.slice(0,8)}</td>
            <td>${fmtUsd(p.entry_price)}</td>
            <td>${p.current_price != null ? fmtUsd(p.current_price) : "—"}</td>
            <td>${fmtUsd(p.size_usd)}</td>
            <td>${p.opened_at}</td>
        </tr>
    `).join("");

    const equityRows = statistics.map(s => {
        const latest = s.equityCurve[s.equityCurve.length - 1];
        return `<div class="adminStat"><span>${s.profileName}</span><strong>${latest ? fmtUsd(latest.equity) : "—"}</strong></div>`;
    }).join("");

    document.getElementById("bhRunDetail").innerHTML = `
        <p class="bhRunSub">${run.name} · <span class="bhStatusPill ${run.status}">${run.status}</span> · duration ${fmtDuration(run.planned_duration_seconds)}</p>

        <p class="bhSectionSubhead">Live Equity (latest snapshot per participant)</p>
        <div class="adminGrid4">${equityRows || "<div class='tbEmptyState'>No snapshots yet.</div>"}</div>

        <p class="bhSectionSubhead">Ranked Report</p>
        <div class="adminTableWrap">
            <table class="adminTable">
                <thead><tr><th>#</th><th>Profile</th><th>Final Balance</th><th>Net Profit</th><th>Return</th><th>Trades</th><th>Win Rate</th><th>Profit Factor</th><th>Max DD</th><th>Acceptance Rate</th><th>Opportunity Capture</th><th>Avg Signal Latency</th></tr></thead>
                <tbody>${reportRows || `<tr><td colspan="12">No report yet.</td></tr>`}</tbody>
            </table>
        </div>

        <p class="bhSectionSubhead">Open Positions (all participants)</p>
        <div class="adminTableWrap">
            <table class="adminTable">
                <thead><tr><th>Token</th><th>Entry Price</th><th>Current Price</th><th>Size</th><th>Opened At</th></tr></thead>
                <tbody>${positionRows || `<tr><td colspan="5">No open positions.</td></tr>`}</tbody>
            </table>
        </div>
    `;

}

async function loadRunDetail(runId){
    selectedRunId = runId;
    try{
        const [run, report, positions, statistics] = await Promise.all([
            adminFetch(`/benchmark/runs/${runId}`),
            adminFetch(`/benchmark/runs/${runId}/report`),
            adminFetch(`/benchmark/runs/${runId}/positions`),
            adminFetch(`/benchmark/runs/${runId}/statistics`)
        ]);
        renderRunDetail({ run, report, positions, statistics });
    }
    catch(e){ noData("bhRunDetail"); }
}

// =====================================
// LOAD
// =====================================

async function loadAll(){
    adminLoading.classList.remove("hidden");
    adminContent.classList.add("hidden");
    await Promise.all([loadHealth(), loadProfiles(), loadRuns()]);
    if(selectedRunId) await loadRunDetail(selectedRunId);
    adminLoading.classList.add("hidden");
    adminContent.classList.remove("hidden");
    if(adminLiveDot) adminLiveDot.classList.add("on");
    if(adminLiveText) adminLiveText.textContent = "LIVE";
}

(function tryAutoResume(){
    if(getAdminKey()){
        adminGate.style.display = "none";
        adminApp.classList.remove("hidden");
        loadAll();
    }
})();
