// =====================================
// CRAB AGENT TRADING BOT DASHBOARD
//
// Monitoring/control UI only - no execution logic. Reuses the exact
// same admin auth/session pattern as js/admin.js (X-Admin-Key header,
// server-side check via server/src/middleware/adminAuth.js) - no
// separate login system. Copied rather than shared via <script> include
// because admin.js binds directly to admin.html's own DOM elements at
// module scope; this file does the same thing for trading-bot.html.
//
// Every render function below shows a real, honest empty state when a
// table has zero rows - it does NOT fabricate sample data. A fresh
// install with no trades yet will show "No open positions", "No trades
// recorded yet", etc.
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

function renderStatusBar(s){
    const el = document.getElementById("tbStatusBar");
    el.innerHTML = `
        <div class="tbStatusGrid">
            <div class="tbStatusCard"><div class="tbLabel">Trading Status</div><div class="tbValue"><span class="tbDot ${s.tradingStatus}"></span>${s.tradingStatus}</div></div>
            <div class="tbStatusCard"><div class="tbLabel">Current Engine</div><div class="tbValue">${s.engine.label}</div></div>
            <div class="tbStatusCard"><div class="tbLabel">Engine</div><div class="tbValue">${s.engine.engineName}</div></div>
            <div class="tbStatusCard"><div class="tbLabel">Exit Strategy</div><div class="tbValue">${s.engine.exitStrategy}</div></div>
            <div class="tbStatusCard"><div class="tbLabel">Executor</div><div class="tbValue">${s.executor} <span class="tbPill tbNeutral">${s.executorStatus}</span></div></div>
            <div class="tbStatusCard"><div class="tbLabel">Mode</div><div class="tbValue">${s.mode}</div></div>
        </div>
    `;

    const startBtn = document.getElementById("tbStartBtn");
    const stopBtn = document.getElementById("tbStopBtn");
    const pauseBtn = document.getElementById("tbPauseBtn");
    startBtn.disabled = s.tradingStatus === "RUNNING";
    pauseBtn.disabled = s.tradingStatus !== "RUNNING";
    stopBtn.disabled = s.tradingStatus === "STOPPED";
}

// =====================================
// CONFIGURATION
// =====================================

const CONFIG_FIELDS = [
    { key: "initial_capital", label: "Initial Capital ($)", step: "1" },
    { key: "position_size_pct", label: "Position Size (%)", step: "1" },
    { key: "max_position_size", label: "Maximum Position Size ($)", step: "1" },
    { key: "max_open_positions", label: "Maximum Open Positions", step: "1" },
    { key: "min_order_size", label: "Minimum Order Size ($)", step: "1" },
    { key: "fee_pct", label: "Fee (%)", step: "0.1" },
    { key: "slippage_pct", label: "Slippage (%)", step: "0.1" },
    { key: "scan_interval_seconds", label: "Scan Interval (seconds)", step: "1" }
];

function renderConfigForm(c){
    const fieldsHtml = CONFIG_FIELDS.map(f => `
        <div class="tbConfigField">
            <label for="tbCfg_${f.key}">${f.label}</label>
            <input type="number" id="tbCfg_${f.key}" step="${f.step}" value="${c[f.key]}">
        </div>
    `).join("");

    document.getElementById("tbConfigForm").innerHTML = `
        <div class="tbConfigGrid">
            ${fieldsHtml}
            <div class="tbConfigField">
                <label for="tbCfg_one_position_per_token">One Position Per Token</label>
                <select id="tbCfg_one_position_per_token">
                    <option value="1" ${c.one_position_per_token ? "selected" : ""}>TRUE</option>
                    <option value="0" ${!c.one_position_per_token ? "selected" : ""}>FALSE</option>
                </select>
            </div>
        </div>
        <div class="tbConfigSaveRow">
            <button id="tbConfigSaveBtn" class="tbBtn tbBtnStart">Save Configuration</button>
            <span id="tbConfigSaveMsg" class="tbControlMsg"></span>
        </div>
    `;

    document.getElementById("tbConfigSaveBtn").onclick = async () => {
        const msgEl = document.getElementById("tbConfigSaveMsg");
        const payload = {};
        for(const f of CONFIG_FIELDS) payload[f.key] = Number(document.getElementById(`tbCfg_${f.key}`).value);
        payload.one_position_per_token = Number(document.getElementById("tbCfg_one_position_per_token").value);
        try{
            const updated = await adminFetch("/tradingbot/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            msgEl.textContent = "Configuration saved.";
            msgEl.className = "tbControlMsg tbMsgOk";
            renderConfigForm(updated);
            loadPortfolio();
        }
        catch(e){
            msgEl.textContent = e.message || "Failed to save configuration.";
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
// OPEN POSITIONS
// =====================================

function renderPositions(positions){
    const el = document.getElementById("tbPositions");
    if(!positions.length){
        el.innerHTML = `<div class="tbEmptyState">No open positions. The bot has not opened any real positions yet - this table will populate once the execution layer (GMGN Executor) is connected in a future phase.</div>`;
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
            <td>${p.exitStrategy || "—"}</td>
            <td>${p.status}</td>
            <td><button class="tbSellBtn" data-token="${p.tokenAddress}">SELL</button></td>
        </tr>
    `).join("");
    el.innerHTML = `
        <div class="adminTableWrap">
            <table class="adminTable">
                <thead><tr><th>Token</th><th>Entry Price</th><th>Current Price</th><th>ROI</th><th>Holding Time</th><th>Confidence</th><th>Exit Strategy</th><th>Status</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
    el.querySelectorAll(".tbSellBtn").forEach(btn => {
        btn.onclick = () => alert("Manual SELL requires a connected executor (GMGN Executor - not implemented yet, see Future Integration section).");
    });
}

// =====================================
// TRADE HISTORY
// =====================================

function renderTrades(trades){
    const el = document.getElementById("tbTrades");
    if(!trades.length){
        el.innerHTML = `<div class="tbEmptyState">No trades recorded yet. Trade History will populate once the bot has executed real trades through a connected executor.</div>`;
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
            <td>${t.reason || "—"}</td>
            <td>${t.engineVersion || "—"}</td>
            <td>${t.txHash ? t.txHash.slice(0,10)+"…" : "—"}</td>
        </tr>
    `).join("");
    el.innerHTML = `
        <div class="adminTableWrap">
            <table class="adminTable">
                <thead><tr><th>Time</th><th>Buy</th><th>Sell</th><th>ROI</th><th>Fee</th><th>Slippage</th><th>Duration</th><th>Reason</th><th>Engine Version</th><th>Tx Hash</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

// =====================================
// LIVE LOG
// =====================================

function renderLog(entries){
    const el = document.getElementById("tbLog");
    if(!entries.length){
        el.innerHTML = `<div class="tbEmptyState">No log entries yet. Use the controls above (START BOT, STOP BOT, etc.) to generate real, timestamped log entries.</div>`;
        return;
    }
    el.innerHTML = entries.map(e => `
        <div class="tbLogLine">
            <span class="tbLogTime">${e.at}</span><span class="tbLogTag ${e.type}">${e.type}</span>${e.tokenSymbol ? `<strong>${e.tokenSymbol}</strong> — ` : ""}${e.message}
        </div>
    `).join("");
}

// =====================================
// FUTURE INTEGRATION PLACEHOLDERS - honest "not built yet" cards, no
// fabricated data.
// =====================================

function renderFuture(){
    document.getElementById("tbFuture").innerHTML = `
        <div class="adminStat"><span>GMGN Executor</span><strong>Not Connected</strong></div>
        <div class="adminStat"><span>Wallet Balance</span><strong>Not Connected</strong></div>
        <div class="adminStat"><span>Transaction Queue</span><strong>Empty (no executor)</strong></div>
        <div class="adminStat"><span>Order Status</span><strong>Not Available</strong></div>
    `;
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
document.getElementById("tbForceSellBtn").onclick = async () => {
    if(!confirm("Force SELL ALL open positions? (No executor connected yet - this only logs the intent.)")) return;
    try{ const r = await adminFetch("/tradingbot/force-sell-all", { method: "POST" }); setControlMsg(`Force Sell All requested - ${r.positionsAffected} position(s) affected.`, "tbMsgOk"); loadLog(); loadPositions(); }
    catch(e){ setControlMsg(e.message, "tbMsgError"); }
};
document.getElementById("tbEmergencyBtn").onclick = async () => {
    if(!confirm("EMERGENCY STOP - force the bot to STOPPED immediately?")) return;
    try{ await adminFetch("/tradingbot/emergency-stop", { method: "POST" }); setControlMsg("EMERGENCY STOP triggered.", "tbMsgError"); loadStatusAndControls(); loadLog(); }
    catch(e){ setControlMsg(e.message, "tbMsgError"); }
};

// =====================================
// LOAD
// =====================================

function noData(id){ document.getElementById(id).innerHTML = `<div class="tbEmptyState">No data available.</div>`; }

async function loadStatusAndControls(){
    try{ renderStatusBar(await adminFetch("/tradingbot/status")); } catch(e){ noData("tbStatusBar"); }
}
async function loadConfig(){
    try{ renderConfigForm(await adminFetch("/tradingbot/config")); } catch(e){ noData("tbConfigForm"); }
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
    try{ renderLog(await adminFetch("/tradingbot/log")); } catch(e){ noData("tbLog"); }
}

async function loadAll(){
    adminLoading.classList.remove("hidden");
    adminContent.classList.add("hidden");
    await Promise.all([loadStatusAndControls(), loadConfig(), loadPortfolio(), loadPositions(), loadTrades(), loadLog()]);
    renderFuture();
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
