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
            }
            catch(e){
                msgEl.textContent = e.message || "Failed to switch strategy.";
                msgEl.className = "tbControlMsg tbMsgError";
            }
        };
    });
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
    dynamicExit: "Dynamic Exit"
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
        <tr>
            <td>${p.tokenSymbol || p.tokenAddress.slice(0,8)}</td>
            <td>${fmtUsd(p.entryPrice)}</td>
            <td>${p.currentPrice != null ? fmtUsd(p.currentPrice) : "—"}</td>
            <td>${p.roiPct != null ? `<span class="tbPill ${p.roiPct >= 0 ? "tbPos" : "tbNeg"}">${fmtPct(p.roiPct)}</span>` : "—"}</td>
            <td>${timeAgo(p.openedAt)}</td>
            <td>${p.confidence != null ? p.confidence : "—"}</td>
            <td>${friendlyReason(p.exitStrategy)}</td>
            <td>${p.status}</td>
            <td><button class="tbSellBtn" data-token="${p.tokenAddress}">SELL</button></td>
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
    el.querySelectorAll(".tbSellBtn").forEach(btn => {
        btn.onclick = () => alert("Manual sell isn't available yet - the bot doesn't have a connected wallet/executor.");
    });
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
            <td>${t.txHash ? t.txHash.slice(0,10)+"…" : "—"}</td>
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

function renderLog(entries, botIsRunning){
    const el = document.getElementById("tbLog");
    if(!entries.length){
        el.innerHTML = `<div class="tbEmptyState">${botIsRunning ? "The bot is monitoring the market for new opportunities." : "Start the bot to see activity here."}</div>`;
        return;
    }
    const liveLine = botIsRunning
        ? `<div class="tbLogLine tbLogLive">Waiting for Market Opportunity...</div>`
        : "";
    el.innerHTML = liveLine + entries.map(e => `
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

async function loadStatusAndControls(){
    try{ renderStatusBar(await adminFetch("/tradingbot/status")); } catch(e){ noData("tbStatusBar"); }
}
async function loadConfig(){
    try{ renderStrategyProfile(await adminFetch("/tradingbot/config")); }
    catch(e){ noData("tbStrategyProfile"); }
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
    await Promise.all([loadStatusAndControls(), loadConfig(), loadPortfolio(), loadPositions(), loadTrades(), loadLog()]);
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
