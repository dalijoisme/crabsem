// =====================================
// CRAB AGENT TRADING BOT DASHBOARD
//
// Monitoring/control UI only - no execution logic. Uses the per-user
// auth system (X-Auth-Token header, server-side check via
// server/src/middleware/userAuth.js, POST /auth/login + POST
// /auth/logout via server/src/routes/v1/auth.js) - fully separate from
// js/admin.js's own X-Admin-Key/ADMIN_PASSWORD system, which this file
// does not touch. Copied rather than shared via <script> include
// because admin.js binds directly to admin.html's own DOM elements at
// module scope; this file does the same thing for trading-bot.html.
//
// Every render function below shows a real, honest empty state when a
// table has zero rows - it does NOT fabricate sample data. A fresh
// install with no trades yet will show "No open positions", "No trades
// recorded yet", etc.
// =====================================

const BASE_URL = (typeof CONFIG !== "undefined" && CONFIG.BACKEND_API_URL) || "http://localhost:4000/api/v1";

const AUTH_TOKEN_STORAGE = "crab_bot_auth_token";

const adminGate = document.getElementById("adminGate");
const adminEmailInput = document.getElementById("tbEmail");
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

function getAuthToken(){
    return sessionStorage.getItem(AUTH_TOKEN_STORAGE) || "";
}

async function adminFetch(path, options = {}){
    const res = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers: { ...(options.headers || {}), "X-Auth-Token": getAuthToken() }
    });
    const json = await res.json().catch(() => null);
    if(res.status === 401){
        sessionStorage.removeItem(AUTH_TOKEN_STORAGE);
        showGate("Session expired or incorrect credentials - please log in again.");
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
    const email = adminEmailInput.value;
    const entered = adminPasswordInput.value;
    if(!email || !entered) return;
    adminGateError.textContent = "";
    adminLoginBtn.disabled = true;
    try{
        const res = await fetch(`${BASE_URL}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password: entered })
        });
        const json = await res.json().catch(() => null);
        if(res.status === 401){ adminGateError.textContent = "Incorrect email or password."; return; }
        if(!res.ok || !json?.success || !json.data?.token){ adminGateError.textContent = `Unexpected error (HTTP ${res.status}).`; return; }
        sessionStorage.setItem(AUTH_TOKEN_STORAGE, json.data.token);
        adminGate.style.display = "none";
        adminApp.classList.remove("hidden");
        adminPasswordInput.value = "";
        loadAll();
    }
    catch(e){ adminGateError.textContent = "Could not reach the backend - check your connection."; }
    finally{ adminLoginBtn.disabled = false; }
}

async function logout(){
    const token = getAuthToken();
    sessionStorage.removeItem(AUTH_TOKEN_STORAGE);
    showGate("");
    if(!token) return;
    try{
        await fetch(`${BASE_URL}/auth/logout`, {
            method: "POST",
            headers: { "X-Auth-Token": token }
        });
    }
    catch(e){ /* local session already cleared; nothing else to do if the server call fails */ }
}

adminLoginBtn.onclick = attemptLogin;
adminPasswordInput.addEventListener("keyup", (e) => { if(e.key === "Enter") attemptLogin(); });
adminLogoutBtn.onclick = logout;
adminRefreshBtn.onclick = () => { loadAll(); tbSettingsDropdown.classList.add("hidden"); };

// =====================================
// SETTINGS MENU - a single "Settings" button revealing Refresh Now +
// Advanced Settings, so the header only ever shows two buttons
// (Settings, Log Out) instead of a row of admin-tool-style actions.
// =====================================

const tbSettingsBtn = document.getElementById("tbSettingsBtn");
const tbSettingsDropdown = document.getElementById("tbSettingsDropdown");

tbSettingsBtn.onclick = (e) => {
    e.stopPropagation();
    tbSettingsDropdown.classList.toggle("hidden");
};
document.addEventListener("click", (e) => {
    if(!tbSettingsDropdown.contains(e.target) && e.target !== tbSettingsBtn){
        tbSettingsDropdown.classList.add("hidden");
    }
});

// =====================================
// FORMAT HELPERS
// =====================================

function fmtUsd(n){ return n == null ? "—" : `$${Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`; }
function fmtPct(n){ return n == null ? "—" : `${Number(n).toFixed(2)}%`; }
function fmtNum(n){ return n == null ? "—" : Number(n).toLocaleString(); }
function fmtDuration(seconds){
    if(seconds == null) return "—";
    const m = Math.floor(seconds/60), s = Math.round(seconds%60);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
function timeAgo(iso){
    if(!iso) return "—";
    const then = new Date(iso.replace(" ","T")+"Z").getTime();
    const diffMin = Math.round((Date.now()-then)/60000);
    if(diffMin < 1) return "just now";
    if(diffMin < 60) return `${diffMin}m ago`;
    return `${Math.round(diffMin/60)}h ago`;
}

// =====================================
// LIVE DECISION CENTER - the dashboard's new home view. Built entirely
// from real, already-computed data (GET /tradingbot/decision-center):
// the bounded decision-snapshot table, the last real cycle/Filtering log
// rows, and two small real health checks (RPC ping, wallet configured).
// Never a placeholder queue, never the full ~12,000-token scan universe.
// =====================================

const STATUS_LABELS = {
    ON_SCHEDULE: "On Schedule", DELAYED: "Delayed", STOPPED: "Stopped", NO_CYCLE_YET: "No Cycle Yet",
    CONNECTED: "Connected", NOT_CONFIGURED: "Not Configured", UNAVAILABLE: "Unavailable", CONFIGURED_UNVERIFIED: "Configured (unverified)"
};

function renderCandidateRow(c){
    const reasonsText = c.reasons && c.reasons.length ? c.reasons.join(" · ") : "No reasons recorded";
    return `
        <div class="tbCandidateRow">
            <span class="tbCandidateSymbol">${c.tokenSymbol || c.tokenAddress.slice(0, 8)}</span>
            <span class="tbPill ${c.action === "AVOID" ? "tbNeg" : (c.action === "HOLD" ? "tbNeutral" : "tbPos")}">${c.action}</span>
            <span class="tbCandidateConfidence">${c.confidence != null ? `${c.confidence}%` : "—"}</span>
            <span class="tbCandidateReasons">${reasonsText}</span>
        </div>
    `;
}

function renderQueue(title, rows, emptyText){
    return `
        <div class="tbQueueCol">
            <h4>${title} (${rows.length})</h4>
            ${rows.length ? rows.map(renderCandidateRow).join("") : `<div class="tbEmptyState">${emptyText}</div>`}
        </div>
    `;
}

function renderDecisionCenter(d){
    const el = document.getElementById("tbDecisionCenter");
    el.innerHTML = `
        <div class="tbStatusGrid">
            <div class="tbStatusCard"><div class="tbLabel">Bot Status</div><div class="tbValue"><span class="tbDot ${d.botStatus}"></span>${d.botStatus}</div></div>
            <div class="tbStatusCard"><div class="tbLabel">Cycle Status</div><div class="tbValue">${STATUS_LABELS[d.cycleStatus] || d.cycleStatus}</div></div>
            <div class="tbStatusCard"><div class="tbLabel">RPC Status</div><div class="tbValue">${STATUS_LABELS[d.rpcStatus] || d.rpcStatus}</div></div>
            <div class="tbStatusCard"><div class="tbLabel">Wallet Status</div><div class="tbValue">${STATUS_LABELS[d.walletStatus] || d.walletStatus}</div></div>
            <div class="tbStatusCard"><div class="tbLabel">Open Slot</div><div class="tbValue">${d.openSlot}</div></div>
            <div class="tbStatusCard"><div class="tbLabel">Remaining Cash</div><div class="tbValue">${fmtUsd(d.remainingCash)}</div></div>
        </div>
        <div class="tbDecisionMeta">
            Last cycle: ${d.lastCycleAt ? timeAgo(d.lastCycleAt) : "never"} ·
            Qualified candidates: ${d.qualifiedCandidateCount}${d.holdCount != null ? ` · Watching: ${d.holdCount}` : ""}${d.avoidCount != null ? ` · Avoided: ${d.avoidCount}` : ""}
        </div>
        <div class="tbQueueGrid">
            ${renderQueue("BUY Queue", d.buyQueue, "No qualified BUY-tier candidates this cycle.")}
            ${renderQueue("WAIT Queue", d.waitQueue, "Nothing on watch this cycle.")}
            ${renderQueue("AVOID (sample)", d.avoidSample, "Nothing avoided this cycle.")}
        </div>
    `;
}

// =====================================
// MOMENTUM KPI - measures whether Momentum Hunter is genuinely getting
// faster at catching momentum. Only real, already-computable metrics are
// shown as numbers; anything needing new data collection (Entry Timing
// Score, Momentum Capture Score, Late Entry %, Time To Peak, Time To BUY,
// Missed Opportunity %) shows an honest "Collecting data" state instead
// of a fabricated score - see services/tradingBotService.js's
// getMomentumKpi for exactly why.
// =====================================

function renderMomentumKpi(k){
    const el = document.getElementById("tbMomentumKpi");
    if(!k.totalTrades){
        el.innerHTML = `<div class="tbEmptyState">No completed trades yet - Momentum KPIs will appear once the bot has closed at least one position.</div>`;
        return;
    }
    el.innerHTML = `
        <div class="adminGrid4">
            <div class="adminStat"><span>Total Trades</span><strong>${fmtNum(k.totalTrades)}</strong></div>
            <div class="adminStat"><span>Avg Holding Time</span><strong>${fmtDuration(k.avgHoldingTimeSeconds)}</strong></div>
            <div class="adminStat"><span>Trades / Hour</span><strong>${k.tradesPerHour != null ? k.tradesPerHour.toFixed(2) : "—"}</strong></div>
            <div class="adminStat"><span>Closes / Hour</span><strong>${k.closesPerHour != null ? k.closesPerHour.toFixed(2) : "—"}</strong></div>
            <div class="adminStat"><span>Avg Rank At Entry</span><strong>${k.avgRankAtEntry != null ? `#${(k.avgRankAtEntry + 1).toFixed(1)}` : "not recorded"}</strong></div>
            <div class="adminStat"><span>Avg Time To Sell (LIVE)</span><strong>${k.avgTimeToSellSampleSize ? fmtDuration(k.avgTimeToSellSeconds) : "N/A (simulation)"}</strong></div>
            <div class="adminStat"><span>Avg Entry Delay</span><strong>${k.avgEntryDelaySeconds != null ? fmtDuration(k.avgEntryDelaySeconds) : "Collecting data"}</strong></div>
            <div class="adminStat"><span>Avg Time To Peak</span><strong>${k.avgTimeToPeakSeconds != null ? fmtDuration(k.avgTimeToPeakSeconds) : "Collecting data"}</strong></div>
            <div class="adminStat"><span>Entry Timing Score</span><strong>Collecting data</strong></div>
            <div class="adminStat"><span>Momentum Capture Score</span><strong>Collecting data</strong></div>
            <div class="adminStat"><span>Missed Opportunity %</span><strong>Collecting data</strong></div>
        </div>
        <div class="tbDecisionMeta">${k.deferredMetricsReason || ""}</div>
    `;
}

// =====================================
// SELF-AUDIT - the sprint's own mandated 24h automatic report. Every
// number is real: scanned/qualified are summed from real cycle-summary/
// Filtering log rows within the window; bought/closed/TP/SL/Dynamic-Exit
// are real counts over trading_bot_trades/positions; nothing here is
// computed on a schedule and cached - it's always fresh on load.
// =====================================

function renderSelfAudit(a){
    const el = document.getElementById("tbSelfAudit");
    el.innerHTML = `
        <div class="adminGrid4">
            <div class="adminStat"><span>Scanned</span><strong>${fmtNum(a.scanned)}</strong></div>
            <div class="adminStat"><span>Qualified</span><strong>${fmtNum(a.qualified)}</strong></div>
            <div class="adminStat"><span>Bought</span><strong>${fmtNum(a.bought)}</strong></div>
            <div class="adminStat"><span>Closed</span><strong>${fmtNum(a.closed)}</strong></div>
            <div class="adminStat"><span>TP</span><strong>${fmtNum(a.tp)}</strong></div>
            <div class="adminStat"><span>SL</span><strong>${fmtNum(a.sl)}</strong></div>
            <div class="adminStat"><span>Dynamic Exit</span><strong>${fmtNum(a.dynamicExit)}</strong></div>
            <div class="adminStat"><span>Manual / External / Rug</span><strong>${fmtNum(a.manual)} / ${fmtNum(a.external)} / ${fmtNum(a.rug)}</strong></div>
            <div class="adminStat"><span>Average Holding</span><strong>${fmtDuration(a.avgHoldingTimeSeconds)}</strong></div>
            <div class="adminStat"><span>Average Entry Rank</span><strong>${a.avgEntryRank != null ? `#${(a.avgEntryRank + 1).toFixed(1)}` : "not recorded"}</strong></div>
            <div class="adminStat"><span>Average Entry Delay</span><strong>${a.avgEntryDelaySeconds != null ? fmtDuration(a.avgEntryDelaySeconds) : "Collecting data"}</strong></div>
            <div class="adminStat"><span>Missed Winner</span><strong>${fmtNum(a.missedWinnerCount)}</strong></div>
        </div>
        <div class="tbDecisionMeta">Rolling ${a.windowHours}-hour window, computed live on every load - not a stored snapshot.</div>
    `;
}

// =====================================
// BOTTLENECK REPORT - Phase 2 (Live Validation & Bottleneck Elimination).
// Real counts, then a real cause-percentage breakdown, in the Founder's
// own vocabulary. Never concludes a bottleneck "is" the problem - only
// ever shows real numbers.
// =====================================

const BOTTLENECK_CATEGORY_LABELS = {
    OPEN_SLOT_FULL: "Open Slot Full",
    TRADING_BALANCE_HABIS: "Trading Balance Habis",
    RISK_REJECTED: "Risk Rejected",
    ENTRY_GATE_REJECTED: "Entry Gate Rejected",
    ALREADY_HOLDING_SIMILAR_POSITION: "Already Holding Similar Position",
    COOLDOWN: "Cooldown",
    OPPORTUNITY_EXPIRED: "Opportunity Expired",
    EXECUTION_FAILED: "Execution Failed",
    OTHER: "Other"
};

function renderBottleneckReport(b){
    const el = document.getElementById("tbBottleneckReport");
    const causesHtml = b.causes.length
        ? b.causes.map(c => `
            <div class="tbTimelineStage">
                <span class="tbTimelineLabel">${BOTTLENECK_CATEGORY_LABELS[c.category] || c.category}</span>
                <span class="tbTimelineDetail">${fmtNum(c.count)} time(s)</span>
                <span class="tbTimelineAt">${c.pct}%</span>
            </div>
        `).join("")
        : `<div class="tbEmptyState">No real missed opportunities recorded in this window.</div>`;

    el.innerHTML = `
        <div class="adminGrid4">
            <div class="adminStat"><span>Qualified</span><strong>${fmtNum(b.qualified)}</strong></div>
            <div class="adminStat"><span>Bought</span><strong>${fmtNum(b.bought)}</strong></div>
            <div class="adminStat"><span>Open Position (now)</span><strong>${fmtNum(b.openPosition)}</strong></div>
            <div class="adminStat"><span>Closed</span><strong>${fmtNum(b.closed)}</strong></div>
            <div class="adminStat"><span>Missed Winner</span><strong>${fmtNum(b.missedWinner)}</strong></div>
            <div class="adminStat"><span>Execution Failures</span><strong>${fmtNum(b.executionFailureCount)}</strong></div>
        </div>
        <h4>Cause Breakdown (${fmtNum(b.totalMissedOpportunities)} real missed opportunities)</h4>
        <div class="tbTimeline">${causesHtml}</div>
        ${b.latestExecutionError ? `<div class="tbDecisionMeta">Latest real execution error (${b.latestExecutionError.status}, ${timeAgo(b.latestExecutionError.at)}): ${b.latestExecutionError.message || "no message recorded"}</div>` : ""}
    `;
}

// =====================================
// SYSTEM THROUGHPUT - Phase 2. Real, windowed measures of how much the
// bot is actually doing.
// =====================================

function renderSystemThroughput(t){
    const el = document.getElementById("tbSystemThroughput");
    el.innerHTML = `
        <div class="adminGrid4">
            <div class="adminStat"><span>Open Position / Hour</span><strong>${t.openPositionPerHour.toFixed(2)}</strong></div>
            <div class="adminStat"><span>Close Position / Hour</span><strong>${t.closePositionPerHour.toFixed(2)}</strong></div>
            <div class="adminStat"><span>Avg Simultaneous Position</span><strong>${t.avgSimultaneousPosition != null ? t.avgSimultaneousPosition.toFixed(1) : "Collecting data"}</strong></div>
            <div class="adminStat"><span>Avg Position Duration</span><strong>${fmtDuration(t.avgPositionDurationSeconds)}</strong></div>
            <div class="adminStat"><span>Capital Utilization</span><strong>${t.capitalUtilizationPct != null ? fmtPct(t.capitalUtilizationPct) : "—"}</strong></div>
            <div class="adminStat"><span>Avg Idle Cash</span><strong>${t.avgIdleCash != null ? fmtUsd(t.avgIdleCash) : "Collecting data"}</strong></div>
            <div class="adminStat"><span>Avg Candidate / Cycle</span><strong>${t.avgCandidatePerCycle != null ? t.avgCandidatePerCycle.toFixed(1) : "—"}</strong></div>
            <div class="adminStat"><span>Avg Queue Length</span><strong>${t.avgQueueLength != null ? t.avgQueueLength.toFixed(1) : "—"}</strong></div>
        </div>
        <div class="tbDecisionMeta">Avg Candidate/Cycle and Avg Queue Length are the same real number, shown under both names.</div>
    `;
}

// =====================================
// TARGET ACHIEVEMENT - Phase 2's own explicit deliverable. Real numbers
// only - CRAB never issues its own "yes"/"no" verdict here, that
// judgment is reserved for the Founder.
// =====================================

function renderTargetAchievement(s){
    const el = document.getElementById("tbTargetAchievement");
    el.innerHTML = `
        <div class="adminGrid4">
            <div class="adminStat"><span>Many Open Positions?</span><strong>${s.manyOpenPositions.openPositionPerHour.toFixed(2)}/hr</strong></div>
            <div class="adminStat"><span>Many Close Positions?</span><strong>${s.manyClosePositions.closePositionPerHour.toFixed(2)}/hr</strong></div>
            <div class="adminStat"><span>Fast Entry?</span><strong>${s.fastEntry.avgEntryDelaySeconds != null ? fmtDuration(s.fastEntry.avgEntryDelaySeconds) : "Collecting data"}</strong></div>
            <div class="adminStat"><span>No Momentum Loss?</span><strong>${s.noMomentumLoss.avgTimeToPeakSeconds != null ? fmtDuration(s.noMomentumLoss.avgTimeToPeakSeconds) : "Collecting data"}</strong> <span class="tbTimelineAt">time to peak</span></div>
        </div>
        <div class="tbDecisionMeta">Real numbers only - CRAB does not judge whether these mean "yes" or "no." That call is yours.</div>
    `;
}

// =====================================
// MISSED WINNERS - real, settled outcomes only (Momentum Validation
// System sprint, this sprint's own stated top priority). A token whose
// outcome hasn't been evaluated yet never appears here - "Hasil Akhir"
// is always a real, real number.
// =====================================

function renderMissedWinners(rows){
    const el = document.getElementById("tbMissedWinners");
    if(!rows.length){
        el.innerHTML = `<div class="tbEmptyState">No settled missed-opportunity outcomes yet.</div>`;
        return;
    }
    const tableRows = rows.map(r => `
        <tr>
            <td>${r.tokenSymbol || r.tokenAddress.slice(0, 8)}</td>
            <td>${r.rankAtSkip != null ? `#${r.rankAtSkip + 1}` : "—"}</td>
            <td>${BOTTLENECK_CATEGORY_LABELS[r.category] || r.category} <span class="tbTimelineAt">(${friendlyReason(r.reason)})</span></td>
            <td>${timeAgo(r.skippedAt)}</td>
            <td>${r.hasOutcome ? `<span class="tbPill ${r.outcomeReturnPct >= 0 ? "tbPos" : "tbNeg"}">${fmtPct(r.outcomeReturnPct)}</span>` : "—"}</td>
        </tr>
    `).join("");
    el.innerHTML = `
        <div class="adminTableWrap">
            <table class="adminTable">
                <thead><tr><th>Token</th><th>Rank At Skip</th><th>Reason</th><th>Skipped</th><th>Outcome</th></tr></thead>
                <tbody>${tableRows}</tbody>
            </table>
        </div>
    `;
}

// =====================================
// STATUS BAR
// =====================================

let currentTradingStatus = null;

function renderStatusBar(s){
    currentTradingStatus = s.tradingStatus;
    const el = document.getElementById("tbStatusBar");
    const canSwitchMode = s.tradingStatus === "STOPPED";
    const nextMode = s.mode === "SIMULATION" ? "LIVE" : "SIMULATION";
    el.innerHTML = `
        <div class="tbStatusGrid">
            <div class="tbStatusCard"><div class="tbLabel">Bot Status</div><div class="tbValue"><span class="tbDot ${s.tradingStatus}"></span>${s.tradingStatus}</div></div>
            <div class="tbStatusCard">
                <div class="tbLabel">Mode</div>
                <div class="tbValue">${s.mode === "SIMULATION" ? "Paper Trading" : s.mode}</div>
                <button id="tbModeToggleBtn" class="tbBtn tbBtnStop" ${canSwitchMode ? "" : "disabled"} title="${canSwitchMode ? "" : "Stop the bot to switch mode"}">
                    Switch to ${nextMode === "SIMULATION" ? "Paper Trading" : "LIVE"}
                </button>
            </div>
            <div class="tbStatusCard"><div class="tbLabel">Executor</div><div class="tbValue">${s.executor} - ${s.executorStatus}</div></div>
        </div>
    `;

    const startBtn = document.getElementById("tbStartBtn");
    const stopBtn = document.getElementById("tbStopBtn");
    const pauseBtn = document.getElementById("tbPauseBtn");
    startBtn.disabled = s.tradingStatus === "RUNNING";
    pauseBtn.disabled = s.tradingStatus !== "RUNNING";
    stopBtn.disabled = s.tradingStatus === "STOPPED";

    const modeBtn = document.getElementById("tbModeToggleBtn");
    if(modeBtn && canSwitchMode){
        modeBtn.onclick = async () => {
            try{
                await adminFetch("/tradingbot/mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: nextMode }) });
                setControlMsg(`Mode switched to ${nextMode}.`, "tbMsgOk");
                loadStatusAndControls();
            }
            catch(e){ setControlMsg(e.message, "tbMsgError"); }
        };
    }
}

// =====================================
// STRATEGY PROFILE - the primary control. One plain-English sentence
// per profile, no technical stat grid (confidence threshold, position
// sizing, cooldowns, etc. are all still real config the Strategy
// Profile owns - they just live in Advanced Settings now, see
// js/advancedSettings.js, not on the main dashboard).
// =====================================

const STRATEGY_PROFILES = [
    { key: "STABLE", label: "Stable", goal: "Steady, low-risk gains with smaller ups and downs." },
    { key: "BALANCED", label: "Balanced (Recommended)", goal: "A mix of growth and risk for well-rounded results." },
    { key: "AGGRESSIVE", label: "Aggressive", goal: "Chases bigger gains by accepting higher risk and bigger swings." }
];

function renderStrategyProfile(c){
    const cardsHtml = STRATEGY_PROFILES.map(p => `
        <div class="tbProfileCard ${c.strategy_profile === p.key ? "tbProfileActive" : ""}">
            <div class="tbProfileName">${p.label}</div>
            <div class="tbProfileGoal">${p.goal}</div>
            <button class="tbBtn ${c.strategy_profile === p.key ? "tbBtnStart" : "tbBtnStop"}" data-profile="${p.key}" ${c.strategy_profile === p.key ? "disabled" : ""}>
                ${c.strategy_profile === p.key ? "ACTIVE" : "SELECT"}
            </button>
        </div>
    `).join("");

    document.getElementById("tbStrategyProfile").innerHTML = `
        <div class="tbProfileGrid">${cardsHtml}</div>
        <div id="tbProfileMsg" class="tbControlMsg"></div>
    `;

    document.getElementById("tbStrategyProfile").querySelectorAll("[data-profile]").forEach(btn => {
        btn.onclick = async () => {
            const msgEl = document.getElementById("tbProfileMsg");
            try{
                const updated = await adminFetch("/tradingbot/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ strategy_profile: btn.dataset.profile }) });
                msgEl.textContent = `Strategy switched to ${btn.dataset.profile}.`;
                msgEl.className = "tbControlMsg tbMsgOk";
                renderStrategyProfile(updated);
                loadPortfolio();
                loadStatusAndControls();
                loadTradingConfiguration(); // a never-customized account's sizing defaults may have just been re-seeded
            }
            catch(e){
                msgEl.textContent = e.message || "Failed to switch strategy.";
                msgEl.className = "tbControlMsg tbMsgError";
            }
        };
    });
}

// =====================================
// TRADING CONFIGURATION - separate from Strategy (the AI Decision
// Engine picker above): position sizing, Max Open Positions, and the
// optional Max Position Size cap are Founder-controlled and independent
// of which strategy profile is active. Real Wallet/Trading/Reserved/
// Available balances, real sizing config - never a fabricated number.
// The live preview mirrors tradeManager.js's own real sizing formula
// exactly (Math.min(cap, percent-or-fixed)) - client-side only, zero
// network round-trip, so it can update on every keystroke.
// =====================================

function fmtSol(n){ return n == null ? "—" : `${Number(n).toFixed(4)} SOL`; }

function renderTradingConfigurationPreview(tc){
    const modeEl = document.getElementById("tcSizingMode");
    const pctEl = document.getElementById("tcPositionSizePct");
    const fixedEl = document.getElementById("tcFixedPositionSizeUsd");
    const capEl = document.getElementById("tcMaxPositionSize");
    const slotsEl = document.getElementById("tcMaxOpenPositions");
    const previewEl = document.getElementById("tcPreview");
    if(!modeEl) return;

    const mode = modeEl.value;
    const availableCash = tc.availableCashUsd ?? 0;
    const rawSize = mode === "FIXED_USD" ? Number(fixedEl.value || 0) : availableCash * (Number(pctEl.value || 0) / 100);
    const cap = Number(capEl.value || 0);
    const effectiveSize = cap > 0 ? Math.min(cap, rawSize) : rawSize;
    const maxOpen = Number(slotsEl.value || 0);
    const estimatedSimultaneous = effectiveSize > 0 ? Math.min(maxOpen, Math.floor(availableCash / effectiveSize)) : 0;

    previewEl.innerHTML = `
        <div class="tbTimelineStage">
            <span class="tbTimelineLabel">Trading Balance</span>
            <span class="tbTimelineDetail">${fmtUsd(availableCash)}</span>
            <span class="tbTimelineAt"></span>
        </div>
        <div class="tbTimelineStage">
            <span class="tbTimelineLabel">Position Size</span>
            <span class="tbTimelineDetail">${fmtUsd(effectiveSize)}</span>
            <span class="tbTimelineAt"></span>
        </div>
        <div class="tbTimelineStage">
            <span class="tbTimelineLabel">Est. Simultaneous Positions</span>
            <span class="tbTimelineDetail">${estimatedSimultaneous}</span>
            <span class="tbTimelineAt">capped by Max Open Positions (${maxOpen || 0})</span>
        </div>
    `;
}

function renderTradingConfiguration(tc){
    const el = document.getElementById("tbTradingConfiguration");
    const s = tc.sizing;

    el.innerHTML = `
        <div class="adminGrid4">
            <div class="adminStat"><span>Wallet Balance</span><strong>${tc.walletBalanceSol != null ? fmtSol(tc.walletBalanceSol) : (tc.walletBalanceUsd != null ? fmtUsd(tc.walletBalanceUsd) : "Unavailable")}</strong></div>
            <div class="adminStat"><span>Trading Allocation</span><strong>${tc.tradingAllocationSol != null ? fmtSol(tc.tradingAllocationSol) : fmtUsd(tc.tradingAllocationUsd)}</strong></div>
            <div class="adminStat"><span>Reserved</span><strong>${tc.reservedSol != null ? fmtSol(tc.reservedSol) : (tc.reservedUsd != null ? fmtUsd(tc.reservedUsd) : "Unavailable")}</strong></div>
            <div class="adminStat"><span>Available Cash</span><strong>${fmtUsd(tc.availableCashUsd)}</strong></div>
        </div>
        <div class="tbDecisionMeta">
            Wallet source: ${tc.walletBalanceSource === "REAL" ? "real on-chain balance" : (tc.walletBalanceSource === "MANUAL_DEPOSIT" ? "manually entered deposit (no real wallet detected yet)" : "unavailable")}${tc.solUsdPrice ? ` · SOL/USD ${fmtUsd(tc.solUsdPrice)}` : ""}
        </div>

        <h4>Position Sizing</h4>
        <div class="tbConfigGrid">
            <div class="tbConfigField">
                <label>Sizing Mode</label>
                <select id="tcSizingMode">
                    <option value="PERCENT" ${s.mode === "PERCENT" ? "selected" : ""}>% of Trading Balance</option>
                    <option value="FIXED_USD" ${s.mode === "FIXED_USD" ? "selected" : ""}>Fixed Amount (USD)</option>
                </select>
            </div>
            <div class="tbConfigField">
                <label>Position Size (% of Trading Balance)</label>
                <input type="number" id="tcPositionSizePct" min="0.1" max="100" step="0.1" value="${s.positionSizePct}">
            </div>
            <div class="tbConfigField">
                <label>Fixed Position Size (USD)</label>
                <input type="number" id="tcFixedPositionSizeUsd" min="1" step="1" value="${s.fixedPositionSizeUsd ?? ""}" placeholder="e.g. 25">
            </div>
            <div class="tbConfigField">
                <label>Max Position Size cap (USD, optional)</label>
                <input type="number" id="tcMaxPositionSize" min="1" step="1" value="${s.maxPositionSize}">
            </div>
            <div class="tbConfigField">
                <label>Max Open Positions</label>
                <input type="number" id="tcMaxOpenPositions" min="1" step="1" value="${s.maxOpenPositions}">
            </div>
            <div class="tbConfigField">
                <label>Min Order Size (USD)</label>
                <input type="number" id="tcMinOrderSize" min="1" step="1" value="${s.minOrderSize}">
            </div>
        </div>

        <h4>Live Preview</h4>
        <div class="tbTimeline" id="tcPreview"></div>

        <div class="tbConfigSaveRow">
            <button id="tcSaveBtn" class="tbBtn tbBtnStart">Save Trading Configuration</button>
            <span id="tcMsg" class="tbControlMsg"></span>
        </div>
        <div class="tbConfigHint">${s.mode === "PERCENT" ? "Percent-of-balance scales automatically with any wallet size - the same setup works whether Trading Balance is 0.28 SOL or 280 SOL." : "Fixed-USD sizing stays the same dollar amount regardless of wallet size - review it if your Trading Balance changes a lot."}</div>
    `;

    function togglePctFixedVisibility(){
        const mode = document.getElementById("tcSizingMode").value;
        document.getElementById("tcPositionSizePct").closest(".tbConfigField").style.display = mode === "PERCENT" ? "" : "none";
        document.getElementById("tcFixedPositionSizeUsd").closest(".tbConfigField").style.display = mode === "FIXED_USD" ? "" : "none";
    }
    togglePctFixedVisibility();
    renderTradingConfigurationPreview(tc);

    ["tcSizingMode", "tcPositionSizePct", "tcFixedPositionSizeUsd", "tcMaxPositionSize", "tcMaxOpenPositions"].forEach(id => {
        document.getElementById(id).addEventListener("input", () => {
            togglePctFixedVisibility();
            renderTradingConfigurationPreview(tc);
        });
    });

    document.getElementById("tcSaveBtn").onclick = async () => {
        const msgEl = document.getElementById("tcMsg");
        const payload = {
            positionSizingMode: document.getElementById("tcSizingMode").value,
            positionSizePct: Number(document.getElementById("tcPositionSizePct").value),
            fixedPositionSizeUsd: document.getElementById("tcFixedPositionSizeUsd").value ? Number(document.getElementById("tcFixedPositionSizeUsd").value) : null,
            maxPositionSize: Number(document.getElementById("tcMaxPositionSize").value),
            maxOpenPositions: Number(document.getElementById("tcMaxOpenPositions").value),
            minOrderSize: Number(document.getElementById("tcMinOrderSize").value)
        };
        try{
            await adminFetch("/tradingbot/trading-configuration", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            msgEl.textContent = "Trading Configuration saved.";
            msgEl.className = "tbControlMsg tbMsgOk";
            loadTradingConfiguration();
            loadMomentumKpi();
        }
        catch(e){
            msgEl.textContent = e.message || "Failed to save Trading Configuration.";
            msgEl.className = "tbControlMsg tbMsgError";
        }
    };
}

// =====================================
// CUSTOM OBJECTIVE - AI STRATEGY ADVISOR (Constitution clause 7 /
// Final Spec section 05/14). Stateless: Analyze never starts the bot -
// the user must review the result and explicitly click Apply & Start.
// =====================================

function renderCustomObjectiveResult(result){
    const resultEl = document.getElementById("tbObjectiveResult");
    if(!result){ resultEl.innerHTML = ""; return; }

    const feasibilityClass = { REALISTIC: "tbPos", AMBITIOUS: "tbNeutral", UNREALISTIC: "tbNeg", INSUFFICIENT_DATA: "tbNeutral" }[result.feasibility] || "tbNeutral";
    const needsAck = result.feasibility === "UNREALISTIC";
    const applyProfile = result.recommendedProfile || "AGGRESSIVE";

    resultEl.innerHTML = `
        <div class="adminGrid4">
            <div class="adminStat"><span>Feasibility</span><strong><span class="tbPill ${feasibilityClass}">${result.feasibility}</span></strong></div>
            <div class="adminStat"><span>Recommended Strategy</span><strong>${result.recommendedProfile || "—"}</strong></div>
            <div class="adminStat"><span>Probability</span><strong>${result.probabilityEstimate.value != null ? result.probabilityEstimate.value + "%" : "Insufficient data"}</strong></div>
            <div class="adminStat"><span>Risk Level</span><strong>${result.riskLevel || "—"}</strong></div>
            <div class="adminStat"><span>Estimated Drawdown</span><strong>${result.estimatedDrawdownPct != null ? fmtPct(result.estimatedDrawdownPct) : "No history yet"}</strong></div>
        </div>
        ${result.warning ? `<div class="tbControlMsg tbMsgError" style="margin-top:12px;">${result.warning}</div>` : ""}
        <p class="tbConfigHint" style="margin-top:10px;">${result.probabilityEstimate.basis}</p>
        <ul class="tbExplanationList">${result.explanation.map(e => `<li>${e}</li>`).join("")}</ul>
        ${needsAck ? `<label class="tbAckRow"><input type="checkbox" id="tbObjectiveAck"> I understand this target is beyond historical performance.</label>` : ""}
        <div class="tbConfigSaveRow">
            <button id="tbObjectiveApplyBtn" class="tbBtn tbBtnStart" ${needsAck ? "disabled" : ""}>Apply ${applyProfile} &amp; Start</button>
            <span id="tbObjectiveApplyMsg" class="tbControlMsg"></span>
        </div>
    `;

    if(needsAck){
        document.getElementById("tbObjectiveAck").onchange = (e) => {
            document.getElementById("tbObjectiveApplyBtn").disabled = !e.target.checked;
        };
    }

    document.getElementById("tbObjectiveApplyBtn").onclick = async () => {
        const msgEl = document.getElementById("tbObjectiveApplyMsg");
        try{
            const updated = await adminFetch("/tradingbot/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ strategy_profile: applyProfile }) });
            renderStrategyProfile(updated);
            await adminFetch("/tradingbot/start", { method: "POST" });
            msgEl.textContent = `${applyProfile} applied and bot started.`;
            msgEl.className = "tbControlMsg tbMsgOk";
            loadStatusAndControls();
        }
        catch(e){
            msgEl.textContent = e.message || "Failed to apply strategy.";
            msgEl.className = "tbControlMsg tbMsgError";
        }
    };
}

function renderCustomObjective(){
    document.getElementById("tbCustomObjective").innerHTML = `
        <div class="tbConfigGrid">
            <div class="tbConfigField"><label for="tbObjModal">Initial Balance ($)</label><input type="number" id="tbObjModal" step="1" min="0" value="100"></div>
            <div class="tbConfigField"><label for="tbObjTarget">Target Balance ($)</label><input type="number" id="tbObjTarget" step="1" min="0" value="1000"></div>
            <div class="tbConfigField"><label for="tbObjDeadline">Deadline</label><input type="date" id="tbObjDeadline"></div>
        </div>
        <div class="tbConfigSaveRow">
            <button id="tbObjectiveAnalyzeBtn" class="tbBtn tbBtnStart">Analyze</button>
            <span id="tbObjectiveMsg" class="tbControlMsg"></span>
        </div>
        <div id="tbObjectiveResult"></div>
    `;

    document.getElementById("tbObjectiveAnalyzeBtn").onclick = async () => {
        const msgEl = document.getElementById("tbObjectiveMsg");
        const modal = Number(document.getElementById("tbObjModal").value);
        const target = Number(document.getElementById("tbObjTarget").value);
        const deadline = document.getElementById("tbObjDeadline").value;
        msgEl.textContent = "Analyzing...";
        msgEl.className = "tbControlMsg";
        try{
            const result = await adminFetch("/tradingbot/custom-objective/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modal, target, deadline }) });
            msgEl.textContent = "";
            renderCustomObjectiveResult(result);
        }
        catch(e){
            msgEl.textContent = e.message || "Failed to analyze.";
            msgEl.className = "tbControlMsg tbMsgError";
        }
    };
}

// =====================================
// PORTFOLIO
// =====================================

// On-Chain Wallet block (Trust/UX sprint): a SEPARATE section from the
// ledger grid above on purpose - Equity/Available Cash above are the
// bot's own self-reported bookkeeping (never queries the chain); this
// block is the real, live wallet balance, so the two can legitimately
// disagree (fees, timing, external activity) without either one lying.
// The Sync Delta is only ever shown when a real USD figure exists -
// never a fabricated/guessed number.
function renderOnChainWallet(p){
    const onChain = p.onChain;
    if(!onChain){
        return `<div class="tbEmptyState">No Trading Wallet yet - generate or import one to see a real on-chain balance here.</div>`;
    }
    if(onChain.unavailableReason){
        return `
            <div class="adminGrid4">
                <div class="adminStat"><span>Wallet Address</span><strong title="${onChain.publicKey}">${onChain.publicKey.slice(0,4)}…${onChain.publicKey.slice(-4)}</strong></div>
                <div class="adminStat"><span>Real SOL Balance</span><strong>Unavailable</strong></div>
            </div>
            <div class="tbEmptyState">Real balance unavailable: ${onChain.unavailableReason}</div>
        `;
    }
    const deltaKnown = p.syncDeltaUsd != null;
    return `
        <div class="adminGrid4">
            <div class="adminStat"><span>Wallet Address</span><strong title="${onChain.publicKey}">${onChain.publicKey.slice(0,4)}…${onChain.publicKey.slice(-4)}</strong></div>
            <div class="adminStat"><span>Real SOL Balance</span><strong>${onChain.solAmount.toFixed(4)} SOL</strong></div>
            <div class="adminStat"><span>Real Balance (USD est.)</span><strong>${onChain.solUsd != null ? fmtUsd(onChain.solUsd) : "Price unavailable"}</strong></div>
            <div class="adminStat"><span>Sync Delta (Ledger − Real)</span><strong>${deltaKnown ? fmtUsd(p.syncDeltaUsd) : "—"}</strong></div>
        </div>
        ${deltaKnown ? `<div class="tbEmptyState">Ledger equity and real wallet balance are expected to differ (fees, timing, activity outside the bot) - this is not an error unless the gap looks wrong to you.</div>` : ""}
    `;
}

function renderPortfolio(p){
    document.getElementById("tbPortfolio").innerHTML = `
        <div class="adminGrid4">
            <div class="adminStat"><span>Available Cash</span><strong>${fmtUsd(p.availableCash)}</strong></div>
            <div class="adminStat"><span>Equity</span><strong>${fmtUsd(p.equity)}</strong></div>
            <div class="adminStat"><span>Open Position Value</span><strong>${fmtUsd(p.openPositionValue)}</strong></div>
            <div class="adminStat"><span>Closed Profit</span><strong>${fmtUsd(p.closedProfit)}</strong></div>
            <div class="adminStat"><span>Unrealized Profit</span><strong>${fmtUsd(p.unrealizedProfit)}</strong></div>
            <div class="adminStat"><span>Realized Profit</span><strong>${fmtUsd(p.realizedProfit)}</strong></div>
            <div class="adminStat"><span>Total Fees</span><strong>${fmtUsd(p.totalFees)}</strong></div>
            <div class="adminStat"><span>Total Trades</span><strong>${fmtNum(p.totalTrades)}</strong></div>
            <div class="adminStat"><span>Win Rate</span><strong>${p.winRate != null ? fmtPct(p.winRate) : "No closed trades yet"}</strong></div>
            <div class="adminStat"><span>Profit Factor</span><strong>${p.profitFactor != null ? p.profitFactor.toFixed(2) : "No closed trades yet"}</strong></div>
            <div class="adminStat"><span>Maximum Drawdown</span><strong>${p.maxDrawdownPct != null ? fmtPct(p.maxDrawdownPct) : "No trade history yet"}</strong></div>
        </div>
    `;
    document.getElementById("tbOnChainWallet").innerHTML = renderOnChainWallet(p);
}

// =====================================
// FRIENDLY LABELS - maps internal reason/exit-strategy codes to plain
// English, shared by Open Positions, Trade History, and the Live Log.
// Falls back to a title-cased version of the raw code rather than a
// blank cell, so an unmapped future code is never hidden, just less
// pretty.
// =====================================

const FRIENDLY_REASONS = {
    STOP_LOSS: "Stop Loss Triggered",
    REVERSAL: "Momentum Reversal",
    MOMENTUM_WEAKENING: "Momentum Weakening",
    TP15: "Target Profit Hit",
    TAKE_PROFIT: "Target Profit Hit",
    dynamicExit: "Dynamic Exit",
    SELL_MANUAL: "Manually Closed",
    SELL_EXTERNAL: "Closed Externally (est. exit)"
};

function friendlyReason(code){
    if(!code) return "—";
    if(FRIENDLY_REASONS[code]) return FRIENDLY_REASONS[code];
    return String(code).replace(/_/g, " ").replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// =====================================
// OPEN POSITIONS
// =====================================

function renderPositions(positions){
    const el = document.getElementById("tbPositions");
    if(!positions.length){
        el.innerHTML = `<div class="tbEmptyState">No open positions yet. The bot will display active trades here.</div>`;
        return;
    }
    const rows = positions.map(p => `
        <tr class="tbPositionRow" data-position-id="${p.id}" title="Click for details">
            <td>${p.tokenSymbol || p.tokenAddress.slice(0,8)}</td>
            <td>${fmtUsd(p.entryPrice)}</td>
            <td>${p.currentPrice != null ? fmtUsd(p.currentPrice) : "—"}</td>
            <td>${p.roiPct != null ? `<span class="tbPill ${p.roiPct >= 0 ? "tbPos" : "tbNeg"}">${fmtPct(p.roiPct)}</span>` : "—"}</td>
            <td>${timeAgo(p.openedAt)}</td>
            <td>${p.confidence != null ? p.confidence : "—"}</td>
            <td>${friendlyReason(p.exitStrategy)}</td>
            <td>${p.status}</td>
            <td><button class="tbSellBtn" data-position-id="${p.id}" data-token-symbol="${p.tokenSymbol || p.tokenAddress.slice(0,8)}">SELL</button></td>
        </tr>
    `).join("");
    el.innerHTML = `
        <div class="adminTableWrap">
            <table class="adminTable">
                <thead><tr><th>Token</th><th>Entry Price</th><th>Current Price</th><th>ROI</th><th>Holding Time</th><th>AI Confidence</th><th>Exit Strategy</th><th>Status</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
    // Real sell - calls the same finalizeClose() path the bot's own
    // automatic exits use. Disabled immediately on click so a slow real
    // network round-trip can never be double-submitted from a second
    // click. stopPropagation so clicking SELL never also opens the
    // row's own detail view.
    el.querySelectorAll(".tbSellBtn").forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const positionId = btn.dataset.positionId;
            const tokenSymbol = btn.dataset.tokenSymbol;
            if(!confirm(`Sell ${tokenSymbol} now at the current market price?`)) return;
            btn.disabled = true;
            btn.textContent = "Selling…";
            try{
                const result = await adminFetch(`/tradingbot/positions/${positionId}/sell`, { method: "POST" });
                if(result.retrying){
                    alert(`Sell submitted for ${tokenSymbol} but not yet confirmed on-chain - it will keep retrying automatically.`);
                }
                await Promise.all([loadPositions(), loadPortfolio(), loadTrades(), loadLog(), loadDecisionCenter()]);
            }
            catch(err){
                alert(`Sell failed: ${err.message}`);
                btn.disabled = false;
                btn.textContent = "SELL";
            }
        };
    });

    // Position Detail view (Trust/UX sprint) - click anywhere on a row
    // (other than SELL) to see the real "why bought" breakdown.
    el.querySelectorAll(".tbPositionRow").forEach(row => {
        row.onclick = () => openPositionDetail(row.dataset.positionId);
    });
}

// =====================================
// POSITION DETAIL - built entirely from real, already-persisted data
// (GET /tradingbot/positions/:id). No re-scoring, no reconstruction -
// an honest "no breakdown recorded" state for any position opened
// before this feature existed, never a fabricated one.
// =====================================

const tbDetailOverlay = document.getElementById("tbPositionDetailOverlay");
const tbPositionDetailContent = document.getElementById("tbPositionDetailContent");
document.getElementById("tbDetailCloseBtn").onclick = () => tbDetailOverlay.classList.add("hidden");
tbDetailOverlay.onclick = (e) => { if(e.target === tbDetailOverlay) tbDetailOverlay.classList.add("hidden"); };

function renderModuleBar(name, m){
    const pct = m.max > 0 ? Math.round((m.score / m.max) * 100) : 0;
    return `
        <div class="tbModuleBar">
            <span>${name}${m.hasData === false ? " (no data)" : ""}</span>
            <div class="tbModuleBarTrack"><div class="tbModuleBarFill" style="width:${pct}%"></div></div>
            <span>${m.score}/${m.max}</span>
        </div>
    `;
}

// Timeline stage helper - "at" is only ever a real timestamp this exact
// position recorded (migration 048's mfe_at/mae_at, or the position/trade
// row's own opened_at/closed_at) or null, never a guessed/interpolated one.
function renderTimelineStage(label, detail, at){
    return `
        <div class="tbTimelineStage">
            <span class="tbTimelineLabel">${label}</span>
            <span class="tbTimelineDetail">${detail}</span>
            <span class="tbTimelineAt">${at ? timeAgo(at) : "not recorded"}</span>
        </div>
    `;
}

function renderPositionDetail(d){
    const strengthHtml = d.strength.length
        ? `<ul class="tbReasonList">${d.strength.map(r => `<li>${r}</li>`).join("")}</ul>`
        : `<div class="tbEmptyState">No strength signals recorded.</div>`;

    const weaknessHtml = d.weakness.length
        ? `<ul class="tbReasonList">${d.weakness.map(r => `<li>${r}</li>`).join("")}</ul>`
        : `<div class="tbEmptyState">No weakness/risk signals recorded.</div>`;

    const breakdownHtml = d.hasBreakdown ? `
        <h4>Participant Breakdown</h4>
        ${Object.entries(d.breakdown.participant || {}).map(([k,m]) => renderModuleBar(k, m)).join("")}
        <h4>Market Breakdown</h4>
        ${Object.entries(d.breakdown.market || {}).map(([k,m]) => renderModuleBar(k, m)).join("")}
        <h4>Acceleration / Flow</h4>
        ${d.acceleration
            ? `<div class="tbEmptyState">priceAccel ${d.acceleration.priceAccel?.toFixed(2)} · flowAccel ${d.acceleration.flowAccel?.toFixed(2)} · liquidityAccel ${d.acceleration.liquidityAccel?.toFixed(2)} · gate ${d.acceleration.gatePassed ? "passed" : "not passed"}</div>`
            : `<div class="tbEmptyState">Not computed for this profile - acceleration/flow only applies to strategies that set it.</div>`}
        <h4>Confidence Breakdown</h4>
        ${d.confidenceBreakdown
            ? `<div class="tbEmptyState">Participant ${d.confidenceBreakdown.participantPct}% · Market ${d.confidenceBreakdown.marketPct}% · Mismatch penalty -${d.confidenceBreakdown.mismatchPenalty} · Freshness penalty -${d.confidenceBreakdown.freshnessPenalty ?? 0}</div>`
            : `<div class="tbEmptyState">Not recorded for this position.</div>`}
    ` : `<div class="tbEmptyState">No breakdown recorded for this position - it was opened before this feature existed.</div>`;

    const timelineHtml = `
        <div class="tbTimeline">
            ${renderTimelineStage("Buy", fmtUsd(d.timeline.buy.price), d.timeline.buy.at)}
            ${renderTimelineStage("+5%", "Crossed", d.timeline.crossed5pct.at)}
            ${renderTimelineStage("+10%", "Crossed", d.timeline.crossed10pct.at)}
            ${renderTimelineStage("Highest", d.timeline.highest.pct != null ? fmtPct(d.timeline.highest.pct) : "—", d.timeline.highest.at)}
            ${renderTimelineStage("Reversal", "Momentum turned here", d.timeline.reversal.at)}
            ${renderTimelineStage("Lowest", d.timeline.lowest.pct != null ? fmtPct(d.timeline.lowest.pct) : "—", d.timeline.lowest.at)}
            ${d.timeline.current ? renderTimelineStage("Current", fmtUsd(d.timeline.current.price), null) : ""}
            ${d.timeline.exit ? renderTimelineStage("Exit", `${fmtUsd(d.timeline.exit.price)} · ${friendlyReason(d.timeline.exit.reason)}`, null) : ""}
            ${d.timeline.sell ? renderTimelineStage("Sell", "Closed", d.timeline.sell.at) : ""}
        </div>
    `;

    const siblingsHtml = d.siblings.length ? `
        <h4>Self-Comparison (same-cycle siblings)</h4>
        <div class="tbTimeline">
            ${d.siblings.map(s => `
                <div class="tbTimelineStage">
                    <span class="tbTimelineLabel">${s.tokenSymbol || s.tokenAddress.slice(0,8)}</span>
                    <span class="tbTimelineDetail">rank #${s.rank + 1}${s.outcomeReturnPct != null ? ` · ${fmtPct(s.outcomeReturnPct)}` : ` · ${s.reason || "no real price history yet"}`}</span>
                    <span class="tbTimelineAt">${s.outperformed === true ? "Outperformed this position" : (s.outperformed === false ? "Did not outperform" : "—")}</span>
                </div>
            `).join("")}
        </div>
    ` : "";

    tbPositionDetailContent.innerHTML = `
        <h3>${d.tokenSymbol || d.tokenAddress.slice(0,8)}</h3>
        <div class="tbDetailSub">${d.status} · opened ${timeAgo(d.timeline.buy.at)}${d.timeline.sell ? ` · closed ${timeAgo(d.timeline.sell.at)}` : ""}</div>
        <div class="adminGrid4">
            <div class="adminStat"><span>Entry Price</span><strong>${fmtUsd(d.entryPrice)}</strong></div>
            <div class="adminStat"><span>Current Price</span><strong>${d.currentPrice != null ? fmtUsd(d.currentPrice) : "—"}</strong></div>
            <div class="adminStat"><span>ROI</span><strong>${d.roiPct != null ? fmtPct(d.roiPct) : "—"}</strong></div>
            <div class="adminStat"><span>Size</span><strong>${fmtUsd(d.sizeUsd)}</strong></div>
            <div class="adminStat"><span>AI Confidence</span><strong>${d.confidence != null ? d.confidence : "—"}</strong></div>
            <div class="adminStat"><span>Risk</span><strong>${d.risk ?? "—"}</strong></div>
            <div class="adminStat"><span>Composite Rank</span><strong>${d.rankAtEntry != null ? `#${d.rankAtEntry + 1} (${d.priorityScoreAtEntry})` : "not recorded"}</strong></div>
            <div class="adminStat"><span>Exit Strategy</span><strong>${friendlyReason(d.exitStrategy)}</strong></div>
            <div class="adminStat"><span>Target Price</span><strong>${d.targetPrice != null ? fmtUsd(d.targetPrice) : "—"}</strong></div>
            <div class="adminStat"><span>Stop Loss Price</span><strong>${d.stopLossPrice != null ? fmtUsd(d.stopLossPrice) : "—"}</strong></div>
            <div class="adminStat"><span>Liquidity</span><strong>${d.liquidity ? `${d.liquidity.score}/${d.liquidity.max}` : "—"}</strong></div>
            <div class="adminStat"><span>Flow</span><strong>${d.flow != null ? d.flow.toFixed(2) : "not computed"}</strong></div>
        </div>
        <h4>Timeline</h4>
        ${timelineHtml}
        <h4>Strength (why BUY)</h4>
        ${strengthHtml}
        <h4>Weakness (risk)</h4>
        ${weaknessHtml}
        ${breakdownHtml}
        ${siblingsHtml}
    `;
}

async function openPositionDetail(positionId){
    tbPositionDetailContent.innerHTML = `<div class="tbEmptyState">Loading…</div>`;
    tbDetailOverlay.classList.remove("hidden");
    try{
        const detail = await adminFetch(`/tradingbot/positions/${positionId}`);
        renderPositionDetail(detail);
    }
    catch(err){
        tbPositionDetailContent.innerHTML = `<div class="tbEmptyState">Failed to load position detail: ${err.message}</div>`;
    }
}

// =====================================
// TRADE HISTORY
// =====================================

function renderTrades(trades){
    const el = document.getElementById("tbTrades");
    if(!trades.length){
        el.innerHTML = `<div class="tbEmptyState">No completed trades yet.</div>`;
        return;
    }
    const rows = trades.map(t => `
        <tr>
            <td>${timeAgo(t.closedAt || t.openedAt)}</td>
            <td>${fmtUsd(t.entryPrice)}</td>
            <td>${t.exitPrice != null ? fmtUsd(t.exitPrice) : "—"}</td>
            <td>${t.roiPct != null ? `<span class="tbPill ${t.roiPct >= 0 ? "tbPos" : "tbNeg"}">${fmtPct(t.roiPct)}</span>` : "—"}</td>
            <td>${fmtUsd(t.feeUsd)}</td>
            <td>${t.slippagePct != null ? fmtPct(t.slippagePct) : "—"}</td>
            <td>${fmtDuration(t.durationSeconds)}</td>
            <td>${friendlyReason(t.reason)}</td>
            <td>${t.txExplorerUrl ? `<a href="${t.txExplorerUrl}" target="_blank" rel="noopener noreferrer">${t.txHash.slice(0,10)}…</a>` : "—"}</td>
        </tr>
    `).join("");
    el.innerHTML = `
        <div class="adminTableWrap">
            <table class="adminTable">
                <thead><tr><th>Time</th><th>Buy</th><th>Sell</th><th>ROI</th><th>Fee</th><th>Slippage</th><th>Duration</th><th>Reason</th><th>Tx Hash</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

// =====================================
// LIVE LOG - plain-English activity feed. logType/message are real,
// structured data from the backend (see tradeManager.js/
// tradingBotService.js) - only the display text is friendlier here,
// nothing is fabricated.
// =====================================

function friendlyLogLine(e){
    if(e.type === "BUY") return `Bought ${e.tokenSymbol || "token"}`;
    if(e.type === "SELL"){
        const match = /-\s*([A-Z_]+)\s*\(/.exec(e.message || "");
        return `Sold ${e.tokenSymbol || "token"} — ${friendlyReason(match ? match[1] : null)}`;
    }
    if(e.type === "SYSTEM"){
        if(/started/i.test(e.message)) return "Bot Started";
        if(/stopped/i.test(e.message)) return "Bot Stopped";
        if(/paused/i.test(e.message)) return "Bot Paused";
        if(/strategy profile switched/i.test(e.message)) return e.message.replace("Bot configuration updated - ", "");
        return e.message;
    }
    if(e.type === "ERROR"){
        if(/emergency stop/i.test(e.message)) return "Emergency Stop Triggered";
        return "Something went wrong - check Advanced Settings for details.";
    }
    return e.message;
}

// Trust/UX sprint: the synthetic "Waiting for Market Opportunity..."
// line used to be injected here regardless of what the bot actually did -
// not backed by any real event. Every running cycle now writes a real
// "Cycle complete: scanned X, opened Y, closed Z, skipped W" SYSTEM row
// (services/tradingBotEngine.js), so the real log entries themselves
// already show the bot is alive - nothing synthetic needs to stand in
// for that anymore.
function renderLog(entries, botIsRunning){
    const el = document.getElementById("tbLog");
    if(!entries.length){
        el.innerHTML = `<div class="tbEmptyState">${botIsRunning ? "The bot is monitoring the market for new opportunities." : "Start the bot to see activity here."}</div>`;
        return;
    }
    el.innerHTML = entries.map(e => `
        <div class="tbLogLine">
            <span class="tbLogTime">${e.at}</span><span class="tbLogTag ${e.type}">${e.type}</span>${friendlyLogLine(e)}
        </div>
    `).join("");
}

// =====================================
// CONTROL BUTTONS
// =====================================

function setControlMsg(text, cls){
    const el = document.getElementById("tbControlMsg");
    el.textContent = text;
    el.className = `tbControlMsg ${cls || ""}`;
}

document.getElementById("tbStartBtn").onclick = async () => {
    try{ await adminFetch("/tradingbot/start", { method: "POST" }); setControlMsg("Bot started.", "tbMsgOk"); loadStatusAndControls(); loadLog(); }
    catch(e){ setControlMsg(e.message, "tbMsgError"); }
};
document.getElementById("tbStopBtn").onclick = async () => {
    try{ await adminFetch("/tradingbot/stop", { method: "POST" }); setControlMsg("Bot stopped.", "tbMsgOk"); loadStatusAndControls(); loadLog(); }
    catch(e){ setControlMsg(e.message, "tbMsgError"); }
};
document.getElementById("tbPauseBtn").onclick = async () => {
    try{ await adminFetch("/tradingbot/pause", { method: "POST" }); setControlMsg("Bot paused.", "tbMsgOk"); loadStatusAndControls(); loadLog(); }
    catch(e){ setControlMsg(e.message, "tbMsgError"); }
};
// Force Sell All / Emergency Stop moved to Advanced Settings
// (js/advancedSettings.js) - rare, high-consequence actions, not
// daily-use controls.

// =====================================
// LOAD
// =====================================

function noData(id){ document.getElementById(id).innerHTML = `<div class="tbEmptyState">No data available.</div>`; }

async function loadDecisionCenter(){
    try{ renderDecisionCenter(await adminFetch("/tradingbot/decision-center")); } catch(e){ noData("tbDecisionCenter"); }
}
async function loadMomentumKpi(){
    try{ renderMomentumKpi(await adminFetch("/tradingbot/momentum-kpi")); } catch(e){ noData("tbMomentumKpi"); }
}
async function loadSelfAudit(){
    try{ renderSelfAudit(await adminFetch("/tradingbot/self-audit")); } catch(e){ noData("tbSelfAudit"); }
}
async function loadMissedWinners(){
    try{ renderMissedWinners(await adminFetch("/tradingbot/missed-winners")); } catch(e){ noData("tbMissedWinners"); }
}
async function loadBottleneckReport(){
    try{ renderBottleneckReport(await adminFetch("/tradingbot/bottleneck-report")); } catch(e){ noData("tbBottleneckReport"); }
}
async function loadSystemThroughput(){
    try{ renderSystemThroughput(await adminFetch("/tradingbot/system-throughput")); } catch(e){ noData("tbSystemThroughput"); }
}
async function loadTargetAchievement(){
    try{ renderTargetAchievement(await adminFetch("/tradingbot/target-achievement")); } catch(e){ noData("tbTargetAchievement"); }
}
async function loadStatusAndControls(){
    try{ renderStatusBar(await adminFetch("/tradingbot/status")); } catch(e){ noData("tbStatusBar"); }
}
async function loadConfig(){
    try{ renderStrategyProfile(await adminFetch("/tradingbot/config")); }
    catch(e){ noData("tbStrategyProfile"); }
}
async function loadTradingConfiguration(){
    try{ renderTradingConfiguration(await adminFetch("/tradingbot/trading-configuration")); }
    catch(e){ noData("tbTradingConfiguration"); }
}
async function loadPortfolio(){
    try{ renderPortfolio(await adminFetch("/tradingbot/portfolio")); } catch(e){ noData("tbPortfolio"); }
}
async function loadPositions(){
    try{ renderPositions(await adminFetch("/tradingbot/positions")); } catch(e){ noData("tbPositions"); }
}
async function loadTrades(){
    try{ renderTrades(await adminFetch("/tradingbot/trades")); } catch(e){ noData("tbTrades"); }
}
async function loadLog(){
    try{ renderLog(await adminFetch("/tradingbot/log"), currentTradingStatus === "RUNNING"); } catch(e){ noData("tbLog"); }
}

async function loadAll(){
    adminLoading.classList.remove("hidden");
    adminContent.classList.add("hidden");
    renderCustomObjective(); // static form, no backend fetch - safe to render before the network round-trip below
    await Promise.all([
        loadDecisionCenter(), loadTargetAchievement(), loadMomentumKpi(), loadSelfAudit(),
        loadBottleneckReport(), loadSystemThroughput(), loadMissedWinners(),
        loadStatusAndControls(), loadConfig(), loadTradingConfiguration(), loadPortfolio(), loadPositions(), loadTrades(), loadLog()
    ]);
    adminLoading.classList.add("hidden");
    adminContent.classList.remove("hidden");
    if(adminLiveDot) adminLiveDot.classList.add("on");
    if(adminLiveText) adminLiveText.textContent = "LIVE";
}

(function tryAutoResume(){
    if(getAuthToken()){
        adminGate.style.display = "none";
        adminApp.classList.remove("hidden");
        loadAll();
    }
})();
