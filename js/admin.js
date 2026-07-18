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

async function loadAll(){

    adminLoading.classList.remove("hidden");

    adminContent.classList.add("hidden");

    try{

        const [dashboard, system, wallets, engineConfig, predictions] = await Promise.all([

            adminFetch("/admin/dashboard"),

            adminFetch("/admin/system"),

            adminFetch("/admin/wallets/summary"),

            adminFetch("/admin/engine/config"),

            adminFetch("/admin/predictions/summary")

        ]);

        renderDashboard(dashboard);

        renderSystem(system);

        renderWallets(wallets);

        renderEngineConfig(engineConfig);

        renderPredictions(predictions);

        renderAnalytics(predictions);

        adminLiveDot.className = "live-dot " + (system.engineStatus === "ok" ? "ok" : "limited");

        adminLiveText.textContent = system.engineStatus === "ok" ? "LIVE" : "LIMITED";

    }
    catch(e){

        console.error("Admin load failed", e);

    }
    finally{

        adminLoading.classList.add("hidden");

        adminContent.classList.remove("hidden");

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

async function walletTable(title, endpoint){

    try{

        const data = await publicFetch(endpoint);

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

    el.innerHTML = `<p class="adminNote">Loading leaderboards...</p>`;

    const [topWallet, topRoi, topWinRate, topTrader, topSmartMoney, topKol, topSniper] = await Promise.all([

        walletTable("Top Wallet (by Score)", "/wallets/leaderboard?sort=score&limit=10"),

        walletTable("Top ROI", "/wallets/leaderboard?sort=avg_roi_pct&limit=10"),

        walletTable("Top Win Rate", "/wallets/leaderboard?sort=win_rate&limit=10"),

        walletTable("Top Trader", "/wallets/search?label=Trader&limit=10"),

        walletTable("Top Smart Money", "/wallets/search?label=Smart%20Money&limit=10"),

        walletTable("Top KOL", "/wallets/search?label=KOL%20Trader&limit=10"),

        walletTable("Top Sniper", "/wallets/search?label=Sniper&limit=10")

    ]);

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
