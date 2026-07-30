// =====================================
// CRAB AGENT - ADVANCED SETTINGS
//
// Technical/rarely-used configuration, split out of the main Trading
// Bot dashboard (js/tradingBot.js) per the consumer-UX simplification
// pass - "hide complexity, expose only what users actually need."
// Reuses the exact same per-user auth token as trading-bot.html
// (sessionStorage["crab_bot_auth_token"], same X-Auth-Token header) -
// no separate login screen here. If the token is missing or rejected,
// this page just sends you back to trading-bot.html to log in.
// =====================================

const BASE_URL = (typeof CONFIG !== "undefined" && CONFIG.BACKEND_API_URL) || "http://localhost:4000/api/v1";

const AUTH_TOKEN_STORAGE = "crab_bot_auth_token";

const adminLoading = document.getElementById("adminLoading");
const adminContent = document.getElementById("adminContent");

function getAuthToken(){
    return sessionStorage.getItem(AUTH_TOKEN_STORAGE) || "";
}

if(!getAuthToken()){
    window.location.href = "trading-bot.html";
}

async function adminFetch(path, options = {}){
    const res = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers: { ...(options.headers || {}), "X-Auth-Token": getAuthToken() }
    });
    const json = await res.json().catch(() => null);
    if(res.status === 401){
        sessionStorage.removeItem(AUTH_TOKEN_STORAGE);
        window.location.href = "trading-bot.html";
        throw new Error("Unauthorized");
    }
    if(!json || !json.success) throw new Error(json?.error || `Request failed (HTTP ${res.status})`);
    return json.data;
}

function fmtPct(n){ return n == null ? "—" : `${Number(n).toFixed(2)}%`; }
function fmtUsd(n){ return n == null ? "—" : `$${Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`; }

function setControlMsg(text, cls){
    const el = document.getElementById("tbControlMsg");
    el.textContent = text;
    el.className = `tbControlMsg ${cls || ""}`;
}

// =====================================
// TECHNICAL CONFIGURATION - same fields as the old main-dashboard
// config form, minus fee_pct (now read-only, see renderFee below) and
// initial_capital (CRAB User Journey v1 - no longer directly settable
// here; it's now DERIVED from Trading Wallet deposit x Trading
// Allocation %, see renderBalances below and
// services/tradingBotService.js's setAllocation()/
// services/walletService.js's depositFunds()). Leaving it editable
// here would let a user silently overwrite a value that must always
// equal deposit x allocation - exactly the "never silently modify"
// principle this sprint is built around.
// =====================================

const CONFIG_FIELDS = [
    { key: "min_order_size", label: "Minimum Order Size ($)", step: "1" },
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
            <div class="tbConfigField">
                <label for="tbCfg_execution_mode">Execution Mode</label>
                <select id="tbCfg_execution_mode">
                    <option value="REGULAR" ${c.execution_mode === "REGULAR" ? "selected" : ""}>Regular</option>
                    <option value="HIGH_THROUGHPUT" ${c.execution_mode === "HIGH_THROUGHPUT" ? "selected" : ""}>High Throughput</option>
                </select>
            </div>
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
        payload.execution_mode = document.getElementById("tbCfg_execution_mode").value;
        try{
            const updated = await adminFetch("/tradingbot/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            msgEl.textContent = "Configuration saved.";
            msgEl.className = "tbControlMsg tbMsgOk";
            renderConfigForm(updated);
            renderFee(updated);
        }
        catch(e){
            msgEl.textContent = e.message || "Failed to save configuration.";
            msgEl.className = "tbControlMsg tbMsgError";
        }
    };
}

// =====================================
// SLIPPAGE PRESETS - Safe/Balanced/Fast instead of a raw percentage.
// Balanced (1%) matches today's actual default, so existing users see
// no behavior change unless they deliberately pick something else.
// =====================================

const SLIPPAGE_PRESETS = [
    { key: "SAFE", label: "Safe", value: 0.5, hint: "Best execution price. May skip very fast-moving opportunities." },
    { key: "BALANCED", label: "Balanced", value: 1, hint: "Recommended for most users." },
    { key: "FAST", label: "Fast", value: 2, hint: "Highest execution speed. May accept higher price deviation." }
];

function closestSlippagePreset(value){
    return SLIPPAGE_PRESETS.reduce((closest, p) =>
        Math.abs(p.value - value) < Math.abs(closest.value - value) ? p : closest
    );
}

function renderSlippage(c){
    const active = closestSlippagePreset(Number(c.slippage_pct));
    const cardsHtml = SLIPPAGE_PRESETS.map(p => `
        <div class="tbProfileCard ${p.key === active.key ? "tbProfileActive" : ""}">
            <div class="tbProfileName">${p.label}</div>
            <div class="tbProfileGoal">${p.hint}</div>
            <button class="tbBtn ${p.key === active.key ? "tbBtnStart" : "tbBtnStop"}" data-slippage="${p.value}" ${p.key === active.key ? "disabled" : ""}>
                ${p.key === active.key ? "ACTIVE" : "SELECT"}
            </button>
        </div>
    `).join("");

    document.getElementById("tbSlippage").innerHTML = `
        <div class="tbProfileGrid">${cardsHtml}</div>
        <div id="tbSlippageMsg" class="tbControlMsg"></div>
    `;

    document.getElementById("tbSlippage").querySelectorAll("[data-slippage]").forEach(btn => {
        btn.onclick = async () => {
            const msgEl = document.getElementById("tbSlippageMsg");
            try{
                const updated = await adminFetch("/tradingbot/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slippage_pct: Number(btn.dataset.slippage) }) });
                msgEl.textContent = "Slippage updated.";
                msgEl.className = "tbControlMsg tbMsgOk";
                renderSlippage(updated);
            }
            catch(e){
                msgEl.textContent = e.message || "Failed to update slippage.";
                msgEl.className = "tbControlMsg tbMsgError";
            }
        };
    });
}

// =====================================
// BALANCES - read-only. CRAB User Journey v1 terminology: "Starting
// Balance" is what you deposited into the Trading Wallet; "Trading
// Balance" is what's actually allocated to the bot (deposit x
// allocation %, see js/onboardingWizard - Phase 6). Both derived
// elsewhere (Deposit/Withdraw, Trading Allocation) - never editable
// here, same reasoning as removing initial_capital from CONFIG_FIELDS
// above.
// =====================================

function renderBalances(walletStatus, botConfig){
    const depositedBalanceUsd = walletStatus?.tradingWallet?.depositedBalanceUsd ?? 0;
    document.getElementById("tbBalances").innerHTML = `
        <div class="adminGrid4">
            <div class="adminStat"><span>Starting Balance</span><strong>${fmtUsd(depositedBalanceUsd)}</strong></div>
            <div class="adminStat"><span>Trading Balance</span><strong>${fmtUsd(botConfig.initial_capital)}</strong></div>
            <div class="adminStat"><span>Trading Allocation</span><strong>${botConfig.allocation_pct}%</strong></div>
        </div>
    `;
}

// =====================================
// PLATFORM FEE - read-only, real value from config. Not editable.
// =====================================

function renderFee(c){
    document.getElementById("tbFee").innerHTML = `
        <div class="adminGrid4">
            <div class="adminStat"><span>Buy</span><strong>${fmtPct(c.fee_pct)}</strong></div>
            <div class="adminStat"><span>Sell</span><strong>${fmtPct(c.fee_pct)}</strong></div>
        </div>
    `;
}

// =====================================
// CURRENT STRATEGY PARAMETERS - the technical stat grid that used to
// live on the main dashboard, read-only here.
// =====================================

function renderStrategyDetail(c){
    document.getElementById("tbStrategyDetail").innerHTML = `
        <p class="tbConfigHint">Read-only - these are set automatically by the Strategy you selected on the main dashboard.</p>
        <div class="adminGrid4">
            <div class="adminStat"><span>Strategy</span><strong>${c.strategy_profile}</strong></div>
            <div class="adminStat"><span>Confidence Threshold</span><strong>${c.min_confidence}%</strong></div>
            <div class="adminStat"><span>Position Size</span><strong>${c.position_size_pct}%</strong></div>
            <div class="adminStat"><span>Max Open Positions</span><strong>${c.max_open_positions}</strong></div>
            <div class="adminStat"><span>Opportunity Priority</span><strong>${c.opportunity_priority_enabled ? "ON" : "OFF"}</strong></div>
            <div class="adminStat"><span>EMI</span><strong>${c.emi_enabled ? "ON" : "OFF"}</strong></div>
            <div class="adminStat"><span>Cooldown (Win / Loss)</span><strong>${c.cooldown_win_minutes}m / ${c.cooldown_loss_minutes}m</strong></div>
        </div>
    `;
}

document.getElementById("tbDetailToggleBtn").onclick = (e) => {
    const detail = document.getElementById("tbStrategyDetail");
    const collapsed = detail.classList.toggle("hidden");
    e.target.textContent = collapsed ? "View Technical Parameters" : "Hide Technical Parameters";
};

// =====================================
// DANGER ZONE
// =====================================

document.getElementById("tbForceSellBtn").onclick = async () => {
    if(!confirm("Force SELL ALL open positions at the current market price? This will attempt to close every open position for real.")) return;
    try{
        const r = await adminFetch("/tradingbot/force-sell-all", { method: "POST" });
        setControlMsg(`Force Sell All completed - ${r.positionsAffected} of ${r.positionsAttempted} open position(s) closed.`, "tbMsgOk");
    }
    catch(e){ setControlMsg(e.message, "tbMsgError"); }
};
document.getElementById("tbEmergencyBtn").onclick = async () => {
    if(!confirm("EMERGENCY STOP - force the bot to STOPPED immediately?")) return;
    try{ await adminFetch("/tradingbot/emergency-stop", { method: "POST" }); setControlMsg("EMERGENCY STOP triggered.", "tbMsgError"); }
    catch(e){ setControlMsg(e.message, "tbMsgError"); }
};

// =====================================
// LOAD
// =====================================

async function loadAll(){
    adminLoading.classList.remove("hidden");
    adminContent.classList.add("hidden");
    try{
        const [config, walletStatus] = await Promise.all([
            adminFetch("/tradingbot/config"),
            adminFetch("/wallet/status")
        ]);
        renderConfigForm(config);
        renderSlippage(config);
        renderBalances(walletStatus, config);
        renderFee(config);
        renderStrategyDetail(config);
    }
    catch(e){ /* adminFetch already redirects on 401; other errors leave the loading state visible */ return; }
    adminLoading.classList.add("hidden");
    adminContent.classList.remove("hidden");
}

loadAll();
