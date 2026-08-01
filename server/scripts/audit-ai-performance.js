// scripts/audit-ai-performance.js - AI Performance Audit Engine.
//
// READ-ONLY. Opens the database with { readonly: true } (better-sqlite3
// physically refuses any write against that handle) and never executes
// anything but SELECT. Does not touch, call, or import any trading-logic
// module (entryGateService/tradeManager/researchEngineFactory/scoring*) -
// this script only reads history that already exists and computes
// statistics over it. Safe to run repeatedly, in production, at any time.
//
// Usage:
//   node scripts/audit-ai-performance.js [--user=<id>] [--min-sample=<n>] [--fn-days=<n>] [--fn-target-pct=<n>] [--db=<path>]
//
//   --user=<id>       Scope every section to one user_id. Default: no
//                      filter (every user_id in the tables, including
//                      NULL/orphaned/test rows) - the report always
//                      prints a per-user_id row-count breakdown FIRST so
//                      contamination (e.g. leftover test-suite rows) is
//                      visible, never silently included or excluded.
//   --min-sample=<n>  Minimum trade count for a bucket/feature/combo to
//                      be reported as a top-N ranking entry (default 3).
//                      Every section still shows its true n - this only
//                      controls what's allowed into "top 20 best/worst"
//                      style rankings, so a single lucky trade can't look
//                      like a validated pattern.
//   --fn-days=<n>     Lookback window (days) for the token_price_history
//                      False Negative scan (default 14) - bounds an
//                      otherwise-unbounded aggregate over a large table.
//   --fn-target-pct=<n>  "Target movement" threshold (mfe_pct, %) for the
//                      Section D False Negative Analyzer over
//                      prediction_history (default 20). Deliberately a
//                      standalone, explicit CLI knob rather than reusing
//                      trading_bot_config.fixed_tp_pct - prediction_history
//                      is the platform-wide "house" pipeline, not this
//                      bot's own exit config, so borrowing that number
//                      silently would assert a link between two unrelated
//                      systems that isn't actually true.
//   --db=<path>       Override the database file (default: server/data/crabsem.sqlite,
//                      or DB_PATH env var).
//
// Output: prints a summary to the terminal AND writes all three formats
// to server/reports/: ai-performance-report.md, .json, .csv. Sections 1-15
// (first sprint) and Sections A-G (this sprint's forensic extension) are
// BOTH always written - this sprint only adds, never removes.

"use strict";

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// ---------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------

function parseArgs(argv){
    const args = { user: null, minSample: 3, fnDays: 14, fnTargetPct: 20, db: null };
    for(const raw of argv){
        const [key, value] = raw.replace(/^--/, "").split("=");
        if(key === "user") args.user = Number(value);
        else if(key === "min-sample") args.minSample = Number(value);
        else if(key === "fn-days") args.fnDays = Number(value);
        else if(key === "fn-target-pct") args.fnTargetPct = Number(value);
        else if(key === "db") args.db = value;
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));

const DB_PATH = args.db || process.env.DB_PATH || path.join(__dirname, "../data/crabsem.sqlite");
const REPORTS_DIR = path.join(__dirname, "../reports");

console.log(`[audit] Opening ${DB_PATH} (readonly)`);
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ---------------------------------------------------------------------
// Small stats helpers - no external dependency, no assumption about
// distribution shape.
// ---------------------------------------------------------------------

function mean(nums){
    const arr = nums.filter(n => n != null && Number.isFinite(n));
    if(!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(nums){
    const arr = nums.filter(n => n != null && Number.isFinite(n)).slice().sort((a, b) => a - b);
    if(!arr.length) return null;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function pearson(pairs){
    const clean = pairs.filter(([x, y]) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y));
    const n = clean.length;
    if(n < 3) return { r: null, n, note: "insufficient data (n<3)" };
    const xs = clean.map(p => p[0]);
    const ys = clean.map(p => p[1]);
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0, dx2 = 0, dy2 = 0;
    for(let i = 0; i < n; i++){
        const dx = xs[i] - mx;
        const dy = ys[i] - my;
        num += dx * dy;
        dx2 += dx * dx;
        dy2 += dy * dy;
    }
    const denom = Math.sqrt(dx2 * dy2);
    return { r: denom === 0 ? null : num / denom, n };
}

function pct(part, whole){
    if(!whole) return null;
    return (part / whole) * 100;
}

function round(n, dp = 2){
    return n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp;
}

function fmtSeconds(s){
    if(s == null) return "n/a";
    if(s < 60) return `${Math.round(s)}s`;
    if(s < 3600) return `${round(s / 60, 1)}m`;
    return `${round(s / 3600, 2)}h`;
}

// Strips volatile per-token numeric detail (dollar amounts, percentages,
// parenthetical specifics, bare counts) from a reasons/riskReasons string
// so "Net accumulation detected ($1,332 net buys, 24h)" and "... ($3,025
// ...)" tally as the SAME feature. Never invents a category name - only
// removes the parts that would otherwise make every occurrence unique.
function normalizeFeature(raw){
    return raw
        .replace(/\([^)]*\)/g, "")
        .replace(/\$[\d,]+(\.\d+)?/g, "")
        .replace(/\b\d+(\.\d+)?%/g, "")
        .replace(/\b\d+\b/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

// ---------------------------------------------------------------------
// Data loaders - every query documented, nothing but SELECT, WHERE the
// user filter applies uniformly wherever a user_id column exists.
// ---------------------------------------------------------------------

const userClause = args.user != null ? "AND user_id = @userId" : "";
const bindUser = args.user != null ? { userId: args.user } : {};

function loadUserBreakdown(){
    return db.prepare(`
        SELECT user_id, COUNT(*) AS trades
        FROM trading_bot_trades
        GROUP BY user_id
        ORDER BY trades DESC
    `).all();
}

// Every CLOSED trade, LEFT JOINed to the position that produced it
// (migration 049's position_id FK) so confidence/risk/breakdown_json/
// rank are available WHERE they exist - never fabricated when they
// don't (pre-migration-049 trades have position_id IS NULL and simply
// carry nulls through here).
function loadTrades(){
    return db.prepare(`
        SELECT
            t.id, t.user_id, t.token_address, t.token_symbol,
            t.entry_price, t.exit_price, t.size_usd, t.roi_pct, t.fee_usd,
            t.duration_seconds, t.reason AS exit_reason, t.engine_version,
            t.opened_at, t.closed_at, t.position_id,
            p.confidence, p.risk, p.rank_at_entry, p.priority_score_at_entry,
            p.breakdown_json
        FROM trading_bot_trades t
        LEFT JOIN trading_bot_positions p ON p.id = t.position_id
        WHERE t.closed_at IS NOT NULL ${userClause.replace("user_id", "t.user_id")}
        ORDER BY t.closed_at ASC
    `).all(bindUser);
}

function loadSkipReasonBreakdown(){
    const rows = db.prepare(`
        SELECT je.key AS reason, je.value AS count
        FROM trading_bot_log,
             json_each(json_extract(meta_json, '$.skipReasons')) AS je
        WHERE message LIKE 'Cycle complete:%' ${userClause}
    `).all(bindUser);
    const tally = new Map();
    for(const r of rows) tally.set(r.reason, (tally.get(r.reason) || 0) + Number(r.count));
    return [...tally.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

// prediction_history: the platform-wide "house" STABLE-profile
// recommendation validation table (NO user_id column - it is not scoped
// to any one trading bot account, and is NOT the same decisions this
// user's own strategy_profile made - see tradingBotScheduler.js's own
// "WIRING FIX" comment on why live scoring stopped reading this table).
// Reported separately and labeled as such, never blended into the
// trading_bot_trades sections above.
function loadPredictionHistorySettled(){
    return db.prepare(`
        SELECT recommendation, confidence, reason_json, status, current_roi_pct, close_reason, time_alive_seconds
        FROM prediction_history
        WHERE status IN ('TP_HIT','SL_HIT','SIGNAL_REVERSED','EXPIRED')
    `).all();
}

function loadFalseNegatives(days){
    return db.prepare(`
        WITH ranked AS (
            SELECT token_address, price, recorded_at,
                   ROW_NUMBER() OVER (PARTITION BY token_address ORDER BY recorded_at ASC) AS rn,
                   MAX(price) OVER (PARTITION BY token_address) AS peak_price
            FROM token_price_history
            WHERE recorded_at >= datetime('now', '-' || @days || ' days')
        ),
        first_seen AS (
            SELECT token_address, price AS first_price, peak_price
            FROM ranked
            WHERE rn = 1
        )
        SELECT fs.token_address, fs.first_price, fs.peak_price
        FROM first_seen fs
        WHERE fs.first_price > 0
          AND NOT EXISTS (SELECT 1 FROM trading_bot_positions p WHERE p.token_address = fs.token_address)
    `).all({ days });
}

function loadConfig(){
    if(args.user == null) return db.prepare("SELECT * FROM trading_bot_config").all();
    return db.prepare("SELECT * FROM trading_bot_config WHERE user_id = ?").all(args.user);
}

// AI Feature Forensic Analyzer sprint (Section C - False Positive
// Analyzer). Filtered entirely in SQL (confidence/roi_pct are plain
// columns on the two real tables, no JSON parsing needed for the filter
// itself) - only the small matched subset ever reaches JS, and only
// there to format its own breakdown_json.reasons for display.
function loadFalsePositiveTrades(){
    return db.prepare(`
        SELECT
            t.id, t.token_address, t.token_symbol, t.roi_pct, t.duration_seconds,
            t.reason AS exit_reason, p.confidence, p.breakdown_json
        FROM trading_bot_trades t
        JOIN trading_bot_positions p ON p.id = t.position_id
        WHERE t.closed_at IS NOT NULL AND t.roi_pct < 0 AND p.confidence >= 50 ${userClause.replace("user_id", "t.user_id")}
        ORDER BY p.confidence DESC
    `).all(bindUser);
}

// AI Feature Forensic Analyzer sprint (Section D - False Negative
// Analyzer). prediction_history is the platform-wide "house" pipeline
// (see this file's header + section10/11's own notes) - the only table
// in this database with a real, historical HOLD/AVOID recommendation
// PLUS a real tracked outcome (mfe_pct: the highest ROI this token ever
// actually reached while tracked). Filtered/sorted/limited entirely in
// SQL against a 700k+ row table using its existing
// idx_prediction_history_recommendation/idx_prediction_history_status
// indexes - never a full-table JS scan.
function loadFalseNegativePredictions(targetPct){
    return db.prepare(`
        SELECT token_address, token_symbol, recommendation, confidence, mfe_pct, status, close_reason, reason_json
        FROM prediction_history
        WHERE recommendation IN ('HOLD', 'AVOID')
          AND status IN ('EXPIRED', 'SL_HIT', 'SIGNAL_REVERSED', 'TP_HIT')
          AND mfe_pct >= @targetPct
        ORDER BY mfe_pct DESC
        LIMIT 50
    `).all({ targetPct });
}

// ---------------------------------------------------------------------
// Section builders - pure functions over already-loaded data.
// ---------------------------------------------------------------------

function winLoss(trades){
    const wins = trades.filter(t => t.roi_pct != null && t.roi_pct > 0);
    const losses = trades.filter(t => t.roi_pct != null && t.roi_pct <= 0);
    return { wins, losses };
}

function realizedPnl(t){
    if(t.size_usd == null || t.roi_pct == null) return null;
    return (t.size_usd * t.roi_pct / 100) - (t.fee_usd || 0);
}

function section1_overall(trades){
    const { wins, losses } = winLoss(trades);
    const withRoi = trades.filter(t => t.roi_pct != null);
    return {
        totalTrades: trades.length,
        totalWins: wins.length,
        totalLosses: losses.length,
        winRatePct: round(pct(wins.length, withRoi.length)),
        avgRoiPct: round(mean(trades.map(t => t.roi_pct))),
        medianRoiPct: round(median(trades.map(t => t.roi_pct))),
        avgHoldingTime: fmtSeconds(mean(trades.map(t => t.duration_seconds))),
        avgHoldingSeconds: round(mean(trades.map(t => t.duration_seconds)), 1),
        avgPositionSizeUsd: round(mean(trades.map(t => t.size_usd))),
        totalRealizedPnlUsd: round(trades.reduce((sum, t) => sum + (realizedPnl(t) || 0), 0), 4)
    };
}

const CONFIDENCE_BUCKETS = [
    { label: "<30", min: -Infinity, max: 30 },
    { label: "30-39", min: 30, max: 40 },
    { label: "40-49", min: 40, max: 50 },
    { label: "50-59", min: 50, max: 60 },
    { label: "60-69", min: 60, max: 70 },
    { label: "70-79", min: 70, max: 80 },
    { label: "80+", min: 80, max: Infinity }
];

function section2_confidenceCalibration(trades){
    const withConfidence = trades.filter(t => t.confidence != null);
    const withoutConfidence = trades.length - withConfidence.length;
    const buckets = CONFIDENCE_BUCKETS.map(b => {
        const inBucket = withConfidence.filter(t => t.confidence >= b.min && t.confidence < b.max);
        const { wins, losses } = winLoss(inBucket);
        return {
            bucket: b.label,
            n: inBucket.length,
            wins: wins.length,
            losses: losses.length,
            winRatePct: round(pct(wins.length, inBucket.length)),
            avgRoiPct: round(mean(inBucket.map(t => t.roi_pct))),
            medianRoiPct: round(median(inBucket.map(t => t.roi_pct))),
            avgHoldingTime: fmtSeconds(mean(inBucket.map(t => t.duration_seconds))),
            // AI Feature Forensic Analyzer sprint (Section F addition):
            totalPnlContributionUsd: round(inBucket.reduce((sum, t) => sum + (realizedPnl(t) || 0), 0), 4)
        };
    });
    const corr = pearson(withConfidence.map(t => [t.confidence, t.roi_pct]));
    return {
        note: `${withConfidence.length}/${trades.length} trade punya confidence tercatat (join ke trading_bot_positions via position_id - ${withoutConfidence} trade lama tidak punya position_id, dilewati, bukan diasumsikan).`,
        buckets,
        confidenceVsRoiCorrelation: corr
    };
}

function extractFeatures(t, key){
    if(!t.breakdown_json) return null;
    let parsed;
    try{ parsed = JSON.parse(t.breakdown_json); }catch(e){ return null; }
    const list = parsed[key];
    if(!Array.isArray(list)) return [];
    return [...new Set(list.map(normalizeFeature).filter(Boolean))];
}

function buildFeatureTally(trades, key){
    const withFeatures = trades.filter(t => extractFeatures(t, key) != null);
    const tally = new Map();
    for(const t of withFeatures){
        const feats = extractFeatures(t, key);
        for(const f of feats){
            if(!tally.has(f)) tally.set(f, { feature: f, trades: [] });
            tally.get(f).trades.push(t);
        }
    }
    const rows = [...tally.values()].map(({ feature, trades: ts }) => {
        const { wins, losses } = winLoss(ts);
        return {
            feature,
            n: ts.length,
            wins: wins.length,
            losses: losses.length,
            winRatePct: round(pct(wins.length, ts.length)),
            avgRoiPct: round(mean(ts.map(t => t.roi_pct))),
            medianRoiPct: round(median(ts.map(t => t.roi_pct))),
            avgConfidence: round(mean(ts.map(t => t.confidence))),
            // AI Feature Forensic Analyzer sprint (Section A additions):
            avgHoldingTime: fmtSeconds(mean(ts.map(t => t.duration_seconds))),
            avgHoldingSeconds: round(mean(ts.map(t => t.duration_seconds)), 1),
            totalPnlContributionUsd: round(ts.reduce((sum, t) => sum + (realizedPnl(t) || 0), 0), 4)
        };
    }).sort((a, b) => b.n - a.n);
    return { coveredTrades: withFeatures.length, totalTrades: trades.length, rows };
}

function section3_featurePerformance(trades){
    return {
        positiveFeatures: buildFeatureTally(trades, "reasons"),
        riskFeatures: buildFeatureTally(trades, "riskReasons")
    };
}

function section4_featureCombinations(trades, minSample){
    const withFeatures = trades.filter(t => extractFeatures(t, "reasons") != null && extractFeatures(t, "reasons").length >= 2);
    const tally = new Map();
    for(const t of withFeatures){
        const feats = extractFeatures(t, "reasons").sort();
        for(let i = 0; i < feats.length; i++){
            for(let j = i + 1; j < feats.length; j++){
                const key = `${feats[i]} + ${feats[j]}`;
                if(!tally.has(key)) tally.set(key, []);
                tally.get(key).push(t);
            }
        }
    }
    const rows = [...tally.entries()].map(([combo, ts]) => {
        const { wins, losses } = winLoss(ts);
        return {
            combo,
            n: ts.length,
            wins: wins.length,
            losses: losses.length,
            winRatePct: round(pct(wins.length, ts.length)),
            avgRoiPct: round(mean(ts.map(t => t.roi_pct))),
            medianRoiPct: round(median(ts.map(t => t.roi_pct)))
        };
    });
    const eligible = rows.filter(r => r.n >= minSample);
    return {
        note: `${withFeatures.length} trade punya >=2 fitur positif untuk dikombinasikan. Hanya kombinasi dengan n >= ${minSample} (--min-sample) masuk ranking di bawah - kombinasi dengan sample lebih kecil TETAP dihitung tapi tidak ditampilkan sebagai ranking supaya tidak terbaca sebagai pola tervalidasi.`,
        totalCombosFound: rows.length,
        eligibleCombos: eligible.length,
        top20Best: eligible.slice().sort((a, b) => b.avgRoiPct - a.avgRoiPct).slice(0, 20),
        top20Worst: eligible.slice().sort((a, b) => a.avgRoiPct - b.avgRoiPct).slice(0, 20)
    };
}

// AI Feature Forensic Analyzer sprint (Section B - triplets). Same exact
// method as the pair combinator above (co-occurrence within a single
// trade's own normalized `reasons` list), one more nested loop for
// 3-way combinations instead of 2-way. Kept as a separate function
// rather than generalizing pairs+triplets into one N-way combinator -
// pairs and triplets are the two shapes actually requested, and a
// generic combinatorial engine would be speculative generality for a
// third shape nobody asked for.
function section4b_featureTriplets(trades, minSample){
    const withFeatures = trades.filter(t => extractFeatures(t, "reasons") != null && extractFeatures(t, "reasons").length >= 3);
    const tally = new Map();
    for(const t of withFeatures){
        const feats = extractFeatures(t, "reasons").sort();
        for(let i = 0; i < feats.length; i++){
            for(let j = i + 1; j < feats.length; j++){
                for(let k = j + 1; k < feats.length; k++){
                    const key = `${feats[i]} + ${feats[j]} + ${feats[k]}`;
                    if(!tally.has(key)) tally.set(key, []);
                    tally.get(key).push(t);
                }
            }
        }
    }
    const rows = [...tally.entries()].map(([combo, ts]) => {
        const { wins, losses } = winLoss(ts);
        return {
            combo,
            n: ts.length,
            wins: wins.length,
            losses: losses.length,
            winRatePct: round(pct(wins.length, ts.length)),
            avgRoiPct: round(mean(ts.map(t => t.roi_pct))),
            medianRoiPct: round(median(ts.map(t => t.roi_pct)))
        };
    });
    const eligible = rows.filter(r => r.n >= minSample);
    return {
        note: `${withFeatures.length} trade punya >=3 fitur positif untuk ditriplet-kan. Sama seperti pair: hanya n >= ${minSample} masuk ranking.`,
        totalCombosFound: rows.length,
        eligibleCombos: eligible.length,
        top20Best: eligible.slice().sort((a, b) => b.avgRoiPct - a.avgRoiPct).slice(0, 20),
        top20Worst: eligible.slice().sort((a, b) => a.avgRoiPct - b.avgRoiPct).slice(0, 20)
    };
}

function section5_falsePositive(trades){
    const tally = buildFeatureTally(trades, "reasons").rows;
    const rows = tally
        .filter(r => r.n > 0)
        .map(r => ({
            feature: r.feature,
            n: r.n,
            wins: r.wins,
            losses: r.losses,
            falsePositiveRatePct: round(pct(r.losses, r.n))
        }))
        .sort((a, b) => b.falsePositiveRatePct - a.falsePositiveRatePct);
    return { rows };
}

function section6_falseNegatives(days){
    let rows;
    try{
        rows = loadFalseNegatives(days);
    }
    catch(err){
        return { available: false, reason: `Query gagal: ${err.message}` };
    }
    const withGain = rows
        .map(r => ({
            tokenAddress: r.token_address,
            firstPrice: r.first_price,
            peakPrice: r.peak_price,
            gainPct: round(((r.peak_price - r.first_price) / r.first_price) * 100)
        }))
        .filter(r => r.gainPct != null && r.gainPct >= 100)
        .sort((a, b) => b.gainPct - a.gainPct);
    return {
        available: true,
        windowDays: days,
        caveat: "Berbasis token_price_history dalam window ini SAJA (dibatasi untuk performa) - 'first_price' adalah harga pertama TERCATAT dalam window, bukan harga saat token pertama kali launch. Token yang naik sebelum window ini tidak akan muncul di sini.",
        top30: withGain.slice(0, 30)
    };
}

const EXIT_LABEL_MAP = {}; // intentionally empty - report whatever `reason` values actually exist, never a hardcoded taxonomy

function section7_exitAnalysis(trades){
    const tally = new Map();
    for(const t of trades){
        const key = t.exit_reason || "(null)";
        if(!tally.has(key)) tally.set(key, []);
        tally.get(key).push(t);
    }
    return [...tally.entries()].map(([reason, ts]) => ({
        exitReason: reason,
        n: ts.length,
        avgRoiPct: round(mean(ts.map(t => t.roi_pct))),
        avgHoldingTime: fmtSeconds(mean(ts.map(t => t.duration_seconds)))
    })).sort((a, b) => b.n - a.n);
}

const HOLDING_BUCKETS = [
    { label: "0-30s", min: 0, max: 30 },
    { label: "30-60s", min: 30, max: 60 },
    { label: "1-3m", min: 60, max: 180 },
    { label: "3-5m", min: 180, max: 300 },
    { label: "5m+", min: 300, max: Infinity }
];

function section8_holdingTime(trades){
    const withDuration = trades.filter(t => t.duration_seconds != null);
    const buckets = HOLDING_BUCKETS.map(b => {
        const inBucket = withDuration.filter(t => t.duration_seconds >= b.min && t.duration_seconds < b.max);
        const { wins } = winLoss(inBucket);
        return {
            bucket: b.label,
            n: inBucket.length,
            winRatePct: round(pct(wins.length, inBucket.length)),
            avgRoiPct: round(mean(inBucket.map(t => t.roi_pct)))
        };
    });
    return { unknownDuration: trades.length - withDuration.length, buckets };
}

function section9_riskGate(){
    return loadSkipReasonBreakdown();
}

function section10_decisionAccuracy(predictionSettled){
    const byRecommendation = new Map();
    for(const p of predictionSettled){
        const key = p.recommendation || "(null)";
        if(!byRecommendation.has(key)) byRecommendation.set(key, []);
        byRecommendation.get(key).push(p);
    }
    const rows = [...byRecommendation.entries()].map(([recommendation, ps]) => {
        const positive = ps.filter(p => p.status === "TP_HIT");
        return {
            recommendation,
            n: ps.length,
            actualPositiveN: positive.length,
            actualPositiveRatePct: round(pct(positive.length, ps.length)),
            avgCurrentRoiPct: round(mean(ps.map(p => p.current_roi_pct)))
        };
    }).sort((a, b) => b.n - a.n);
    return {
        source: "prediction_history (platform-wide STABLE-profile 'house' recommendation, BUKAN keputusan strategy_profile milik user ini - lihat catatan di bagian 11).",
        caveat: "trading_bot_decision_snapshot TIDAK bisa dipakai untuk ini - tabel itu di-DELETE+INSERT ulang setiap cycle (lihat tradingBotEngine.js runCycle), jadi hanya mencerminkan cycle TERAKHIR, tidak punya histori.",
        outcomeDefinition: "actualPositive = status TP_HIT. Baris status OPEN/DECISION_ONLY dikecualikan (belum settled).",
        rows
    };
}

function section11_predictionAccuracy(predictionSettled){
    const positive = new Set(["BUY", "STRONG BUY"]);
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for(const p of predictionSettled){
        const predictedPositive = positive.has((p.recommendation || "").toUpperCase());
        const actualPositive = p.status === "TP_HIT";
        if(predictedPositive && actualPositive) tp++;
        else if(predictedPositive && !actualPositive) fp++;
        else if(!predictedPositive && actualPositive) fn++;
        else tn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall = tp + fn > 0 ? tp / (tp + fn) : null;
    const accuracy = (tp + tn + fp + fn) > 0 ? (tp + tn) / (tp + tn + fp + fn) : null;
    const f1 = (precision != null && recall != null && (precision + recall) > 0)
        ? (2 * precision * recall) / (precision + recall) : null;
    return {
        source: "prediction_history, status IN (TP_HIT, SL_HIT, SIGNAL_REVERSED, EXPIRED) - platform-wide, bukan trade milik user ini.",
        definition: {
            predictedPositive: "recommendation IN ('BUY','STRONG BUY')",
            actualPositive: "status = 'TP_HIT'",
            actualNegative: "status IN ('SL_HIT','SIGNAL_REVERSED','EXPIRED')"
        },
        n: predictionSettled.length,
        confusionMatrix: { truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn },
        precision: round(precision, 4),
        recall: round(recall, 4),
        accuracy: round(accuracy, 4),
        f1: round(f1, 4)
    };
}

function section12_correlations(trades){
    const riskOrdinal = { LOW: 1, MEDIUM: 2, HIGH: 3 };
    function tokenAgeMinutes(t){
        if(!t.breakdown_json) return null;
        try{ return JSON.parse(t.breakdown_json).tokenAgeMinutesAtEntry ?? null; }
        catch(e){ return null; }
    }
    return {
        confidenceVsRoi: pearson(trades.map(t => [t.confidence, t.roi_pct])),
        holdingTimeVsRoi: pearson(trades.map(t => [t.duration_seconds, t.roi_pct])),
        tokenAgeMinutesVsRoi: {
            ...pearson(trades.map(t => [tokenAgeMinutes(t), t.roi_pct])),
            note: "'market age' tidak tersimpan per posisi - proxy yang tersedia adalah tokenAgeMinutesAtEntry (usia token sejak launch) dari breakdown_json."
        },
        priorityScoreVsRoi: pearson(trades.map(t => [t.rank_at_entry != null ? t.priority_score_at_entry : null, t.roi_pct])),
        riskOrdinalVsRoi: {
            ...pearson(trades.map(t => [t.risk ? riskOrdinal[t.risk] ?? null : null, t.roi_pct])),
            note: "risk (TEXT: LOW/MEDIUM/HIGH) dipetakan ke ordinal 1/2/3 khusus untuk korelasi ini."
        }
    };
}

function tradeDetailRow(t){
    const feats = extractFeatures(t, "reasons");
    return {
        id: t.id, tokenSymbol: t.token_symbol, tokenAddress: t.token_address,
        confidence: t.confidence, risk: t.risk,
        roiPct: round(t.roi_pct), holdingTime: fmtSeconds(t.duration_seconds),
        holdingSeconds: t.duration_seconds,
        reasons: feats ? feats.join("; ") : "(no breakdown_json)"
    };
}

function section13_topWinners(trades){
    return trades.filter(t => t.roi_pct != null).slice().sort((a, b) => b.roi_pct - a.roi_pct).slice(0, 30).map(tradeDetailRow);
}

function section14_topLosers(trades){
    return trades.filter(t => t.roi_pct != null).slice().sort((a, b) => a.roi_pct - b.roi_pct).slice(0, 30).map(tradeDetailRow);
}

function section15_recommendations(s3, s4, s2, minSample){
    const overallWinRate = mean(s2.buckets.flatMap(b => Array(b.n).fill(b.winRatePct ?? 0))); // rough weighted reference only
    function classify(rows){
        return rows.filter(r => r.n >= minSample).map(r => {
            let verdict;
            if(r.winRatePct == null) verdict = "DATA TIDAK CUKUP";
            else if(r.winRatePct >= 66) verdict = "NAIKKAN BOBOT";
            else if(r.winRatePct >= 40) verdict = "PERTAHANKAN";
            else if(r.winRatePct >= 20) verdict = "TURUNKAN BOBOT";
            else verdict = "PERTIMBANGKAN HAPUS";
            return { feature: r.feature, n: r.n, winRatePct: r.winRatePct, avgRoiPct: r.avgRoiPct, verdict };
        });
    }
    return {
        caveat: `Ini adalah SARAN STATISTIK murni dari histori yang ada (n>=${minSample} saja yang dinilai) - BUKAN perubahan kode, BUKAN keputusan otomatis. Dengan sample size sekecil ini, anggap sebagai hipotesis awal, bukan kesimpulan final.`,
        positiveFeatureVerdicts: classify(s3.positiveFeatures.rows),
        riskFeatureVerdicts: classify(s3.riskFeatures.rows),
        bestCombinations: s4.top20Best.slice(0, 5),
        worstCombinations: s4.top20Worst.slice(0, 5)
    };
}

// =======================================================================
// AI FEATURE FORENSIC ANALYZER (this sprint's extension) - Sections A-G.
// Additive only: every function below is NEW, nothing above this line
// was removed or behaviorally changed by this sprint (buildFeatureTally/
// section2's bucket builder only gained extra fields - see the "Section A
// additions"/"Section F addition" comments above - existing fields are
// untouched).
// =======================================================================

// Section C - False Positive Analyzer: real per-trade rows (not an
// aggregate), confidence >= 50 AND roi_pct < 0, sorted by confidence
// DESC - exactly the definition requested, filtered in SQL (see
// loadFalsePositiveTrades above).
function sectionC_falsePositives(rows){
    return rows.map(r => {
        const feats = extractFeatures(r, "reasons");
        return {
            tokenSymbol: r.token_symbol, tokenAddress: r.token_address,
            confidence: r.confidence, roiPct: round(r.roi_pct),
            holdingTime: fmtSeconds(r.duration_seconds),
            reasons: feats ? feats.join("; ") : "(no breakdown_json)",
            exitReason: r.exit_reason
        };
    });
}

// Section D - False Negative Analyzer: see loadFalseNegativePredictions's
// own header comment for the exact table/definition used and why. Honest
// "INSUFFICIENT DATA" when nothing matches - never a fabricated row.
function sectionD_falseNegatives(rows, targetPct){
    if(!rows.length){
        return {
            available: false,
            message: `INSUFFICIENT DATA - tidak ada baris prediction_history dengan recommendation HOLD/AVOID, status settled, dan mfe_pct >= ${targetPct}%. Coba turunkan --fn-target-pct kalau ingin threshold lebih longgar.`
        };
    }
    return {
        available: true,
        source: "prediction_history (platform-wide 'house' STABLE profile - lihat catatan Section 10/11 di atas; BUKAN keputusan strategy_profile akun ini).",
        targetMovementPct: targetPct,
        definition: "recommendation IN (HOLD, AVOID) AND status settled (EXPIRED/SL_HIT/SIGNAL_REVERSED/TP_HIT) AND mfe_pct >= target - token yang AI 'lewatkan' tapi nyatanya pernah bergerak sejauh target.",
        rows: rows.map(r => ({
            tokenSymbol: r.token_symbol, tokenAddress: r.token_address,
            recommendation: r.recommendation, confidence: r.confidence,
            mfePct: round(r.mfe_pct), status: r.status, closeReason: r.close_reason
        }))
    };
}

// Section E - Feature Recommendation. Same underlying stats as Section
// 15/A, re-labeled to the exact English verdict vocabulary requested
// ("Increase weight" / "Decrease weight") instead of duplicating the
// classification thresholds a second time.
function sectionE_recommendation(rows, minSample){
    return rows.filter(r => r.n >= minSample).map(r => {
        let recommendation;
        if(r.winRatePct == null) recommendation = "Insufficient data";
        else if(r.winRatePct >= 66) recommendation = "Increase weight";
        else if(r.winRatePct >= 40) recommendation = "Maintain";
        else if(r.winRatePct >= 20) recommendation = "Decrease weight";
        else recommendation = "Consider removing";
        return { feature: r.feature, trades: r.n, winRatePct: r.winRatePct, avgRoiPct: r.avgRoiPct, recommendation };
    }).sort((a, b) => b.trades - a.trades);
}

// ---------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------

function buildReport(){
    const userBreakdown = loadUserBreakdown();
    const trades = loadTrades();
    const predictionSettled = loadPredictionHistorySettled();
    const config = loadConfig();

    const s1 = section1_overall(trades);
    const s2 = section2_confidenceCalibration(trades);
    const s3 = section3_featurePerformance(trades);
    const s4 = section4_featureCombinations(trades, args.minSample);
    const s5 = section5_falsePositive(trades);
    const s6 = section6_falseNegatives(args.fnDays);
    const s7 = section7_exitAnalysis(trades);
    const s8 = section8_holdingTime(trades);
    const s9 = section9_riskGate();
    const s10 = section10_decisionAccuracy(predictionSettled);
    const s11 = section11_predictionAccuracy(predictionSettled);
    const s12 = section12_correlations(trades);
    const s13 = section13_topWinners(trades);
    const s14 = section14_topLosers(trades);
    const s15 = section15_recommendations(s3, s4, s2, args.minSample);

    // AI Feature Forensic Analyzer sprint - Sections A-G. A/F reuse s3/s2
    // (now enriched with holding-time/PnL fields) directly rather than
    // recomputing the same aggregation a second time under a new name.
    const sB_triplets = section4b_featureTriplets(trades, args.minSample);
    const falsePositiveTradeRows = loadFalsePositiveTrades();
    const sC = sectionC_falsePositives(falsePositiveTradeRows);
    const falseNegativeRows = loadFalseNegativePredictions(args.fnTargetPct);
    const sD = sectionD_falseNegatives(falseNegativeRows, args.fnTargetPct);
    const sE = sectionE_recommendation(s3.positiveFeatures.rows, args.minSample);

    return {
        generatedAt: new Date().toISOString(),
        dbPath: DB_PATH,
        userFilter: args.user,
        minSample: args.minSample,
        userBreakdown,
        configRows: config,
        sections: {
            overallPerformance: s1,
            confidenceCalibration: s2,
            featurePerformance: s3,
            featureCombinations: s4,
            falsePositiveAnalysis: s5,
            falseNegativeAnalysis: s6,
            exitAnalysis: s7,
            holdingTimeAnalysis: s8,
            riskGateAnalysis: s9,
            decisionSnapshotAccuracy: s10,
            predictionAccuracy: s11,
            correlations: s12,
            topWinners: s13,
            topLosers: s14,
            recommendations: s15,
            // Sections A-G (AI Feature Forensic Analyzer sprint) - additive,
            // sits alongside every section above, none of which changed shape.
            sectionA_featureForensicRanking: s3,
            sectionB_combinations: { pairs: s4, triplets: sB_triplets },
            sectionC_falsePositiveTrades: sC,
            sectionD_falseNegativePredictions: sD,
            sectionE_featureRecommendation: sE,
            sectionF_confidenceCalibration: s2
        },
        tradesForCsv: trades
    };
}

// ---------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------

function mdTable(rows, columns){
    if(!rows.length) return "_(tidak ada data)_\n";
    const header = `| ${columns.map(c => c.label).join(" | ")} |`;
    const sep = `| ${columns.map(() => "---").join(" | ")} |`;
    const body = rows.map(r => `| ${columns.map(c => r[c.key] ?? "").join(" | ")} |`).join("\n");
    return `${header}\n${sep}\n${body}\n`;
}

function renderMarkdown(report){
    const s = report.sections;
    let md = "";
    md += `# AI Performance Audit Report\n\n`;
    md += `Generated: ${report.generatedAt}\n\n`;
    md += `Database: \`${report.dbPath}\`\n\n`;
    md += `User filter: ${report.userFilter ?? "(tidak difilter - lihat breakdown per user_id di bawah)"}\n\n`;
    md += `## Data Availability - user_id breakdown (trading_bot_trades)\n\n`;
    md += mdTable(report.userBreakdown, [{ key: "user_id", label: "user_id" }, { key: "trades", label: "trades" }]);
    md += `\n**Perhatikan baris user_id yang janggal (null, atau akun dengan 1 trade saja) - kemungkinan besar itu data uji coba (test suite), bukan trading nyata. Jalankan ulang dengan --user=<id_asli_anda> untuk hasil yang bersih.**\n\n`;

    md += `## 1. Overall Performance\n\n`;
    md += "```json\n" + JSON.stringify(s.overallPerformance, null, 2) + "\n```\n\n";

    md += `## 2. Confidence Calibration\n\n${s.confidenceCalibration.note}\n\n`;
    md += mdTable(s.confidenceCalibration.buckets, [
        { key: "bucket", label: "Bucket" }, { key: "n", label: "n" },
        { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" },
        { key: "medianRoiPct", label: "Median ROI %" }, { key: "avgHoldingTime", label: "Avg Holding" }
    ]);
    md += `\nConfidence vs ROI correlation: r=${s.confidenceCalibration.confidenceVsRoiCorrelation.r ?? "n/a"} (n=${s.confidenceCalibration.confidenceVsRoiCorrelation.n})\n\n`;

    md += `## 3. Feature Performance\n\n### Positive reasons (breakdown_json.reasons)\n\n`;
    md += `Coverage: ${s.featurePerformance.positiveFeatures.coveredTrades}/${s.featurePerformance.positiveFeatures.totalTrades} trade\n\n`;
    md += mdTable(s.featurePerformance.positiveFeatures.rows, [
        { key: "feature", label: "Feature" }, { key: "n", label: "n" }, { key: "wins", label: "Win" }, { key: "losses", label: "Loss" },
        { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }, { key: "avgConfidence", label: "Avg Conf." }
    ]);
    md += `\n### Risk reasons (breakdown_json.riskReasons)\n\n`;
    md += mdTable(s.featurePerformance.riskFeatures.rows, [
        { key: "feature", label: "Feature" }, { key: "n", label: "n" }, { key: "wins", label: "Win" }, { key: "losses", label: "Loss" },
        { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }, { key: "avgConfidence", label: "Avg Conf." }
    ]);

    md += `\n## 4. Feature Combinations\n\n${s.featureCombinations.note}\n\n`;
    md += `Total kombinasi ditemukan: ${s.featureCombinations.totalCombosFound}, memenuhi --min-sample: ${s.featureCombinations.eligibleCombos}\n\n`;
    md += `### Top 20 Terbaik\n\n`;
    md += mdTable(s.featureCombinations.top20Best, [
        { key: "combo", label: "Kombinasi" }, { key: "n", label: "n" }, { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }
    ]);
    md += `\n### Top 20 Terburuk\n\n`;
    md += mdTable(s.featureCombinations.top20Worst, [
        { key: "combo", label: "Kombinasi" }, { key: "n", label: "n" }, { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }
    ]);

    md += `\n## 5. False Positive Analysis\n\nFeature yang paling sering muncul di trade LOSS (diurutkan berdasarkan false-positive rate):\n\n`;
    md += mdTable(s.falsePositiveAnalysis.rows, [
        { key: "feature", label: "Feature" }, { key: "n", label: "Muncul" }, { key: "losses", label: "Loss" }, { key: "wins", label: "Win" }, { key: "falsePositiveRatePct", label: "False Positive %" }
    ]);

    md += `\n## 6. False Negative Analysis\n\n`;
    if(!s.falseNegativeAnalysis.available){
        md += `Tidak tersedia: ${s.falseNegativeAnalysis.reason}\n\n`;
    }
    else{
        md += `Window: ${s.falseNegativeAnalysis.windowDays} hari. ${s.falseNegativeAnalysis.caveat}\n\n`;
        md += `Token yang naik >=100% (dalam window ini) tapi TIDAK PERNAH dibeli:\n\n`;
        md += mdTable(s.falseNegativeAnalysis.top30, [
            { key: "tokenAddress", label: "Token" }, { key: "firstPrice", label: "First Price" }, { key: "peakPrice", label: "Peak Price" }, { key: "gainPct", label: "Gain %" }
        ]);
    }

    md += `\n## 7. Exit Analysis\n\n`;
    md += mdTable(s.exitAnalysis, [
        { key: "exitReason", label: "Exit Reason (nilai asli dari DB)" }, { key: "n", label: "n" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "avgHoldingTime", label: "Avg Holding" }
    ]);

    md += `\n## 8. Holding Time Analysis\n\nUnknown duration: ${s.holdingTimeAnalysis.unknownDuration}\n\n`;
    md += mdTable(s.holdingTimeAnalysis.buckets, [
        { key: "bucket", label: "Bucket" }, { key: "n", label: "n" }, { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }
    ]);

    md += `\n## 9. Risk Gate Analysis (ranking penolakan, dari trading_bot_log.meta_json.skipReasons)\n\n`;
    md += mdTable(s.riskGateAnalysis, [{ key: "reason", label: "Reason" }, { key: "count", label: "Count" }]);

    md += `\n## 10. Decision Snapshot Accuracy\n\n${s.decisionSnapshotAccuracy.source}\n\n${s.decisionSnapshotAccuracy.caveat}\n\n${s.decisionSnapshotAccuracy.outcomeDefinition}\n\n`;
    md += mdTable(s.decisionSnapshotAccuracy.rows, [
        { key: "recommendation", label: "Recommendation" }, { key: "n", label: "n" }, { key: "actualPositiveN", label: "TP_HIT" }, { key: "actualPositiveRatePct", label: "TP Rate %" }, { key: "avgCurrentRoiPct", label: "Avg ROI %" }
    ]);

    md += `\n## 11. Prediction Accuracy\n\n${s.predictionAccuracy.source}\n\n`;
    md += "```json\n" + JSON.stringify(s.predictionAccuracy, null, 2) + "\n```\n\n";

    md += `## 12. Feature Correlation (Pearson r)\n\n`;
    md += "```json\n" + JSON.stringify(s.correlations, null, 2) + "\n```\n\n";

    md += `## 13. Top 30 Winners\n\n`;
    md += mdTable(s.topWinners, [
        { key: "tokenSymbol", label: "Token" }, { key: "confidence", label: "Conf." }, { key: "roiPct", label: "ROI %" }, { key: "holdingTime", label: "Holding" }, { key: "reasons", label: "Reasons" }
    ]);

    md += `\n## 14. Top 30 Losers\n\n`;
    md += mdTable(s.topLosers, [
        { key: "tokenSymbol", label: "Token" }, { key: "confidence", label: "Conf." }, { key: "roiPct", label: "ROI %" }, { key: "holdingTime", label: "Holding" }, { key: "reasons", label: "Reasons" }
    ]);

    md += `\n## 15. Recommendation Engine (SARAN STATISTIK, BUKAN PATCH)\n\n${s.recommendations.caveat}\n\n`;
    md += `### Positive Features\n\n`;
    md += mdTable(s.recommendations.positiveFeatureVerdicts, [
        { key: "feature", label: "Feature" }, { key: "n", label: "n" }, { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "verdict", label: "Verdict" }
    ]);
    md += `\n### Risk Features\n\n`;
    md += mdTable(s.recommendations.riskFeatureVerdicts, [
        { key: "feature", label: "Feature" }, { key: "n", label: "n" }, { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "verdict", label: "Verdict" }
    ]);

    // =====================================================================
    // AI FEATURE FORENSIC ANALYZER (Sections A-G) - appended after the
    // original 15 sections above, which are untouched.
    // =====================================================================

    md += `\n\n---\n\n# AI Feature Forensic Analyzer (Sections A-G)\n\n`;

    md += `## Section A: Feature Forensic Ranking\n\nFitur dinormalisasi (angka/persen/parenthetical dihapus) sebelum ditally - lihat \`normalizeFeature()\`. Diurutkan dari sample (n) terbesar.\n\n`;
    md += mdTable(s.sectionA_featureForensicRanking.positiveFeatures.rows, [
        { key: "feature", label: "Feature" }, { key: "n", label: "Trades" }, { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" },
        { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" },
        { key: "avgHoldingTime", label: "Avg Holding" }, { key: "totalPnlContributionUsd", label: "Total PnL (USD)" }
    ]);

    md += `\n## Section B: Feature Combinations\n\n### Pairs - Top Winning\n\n`;
    md += mdTable(s.sectionB_combinations.pairs.top20Best, [
        { key: "combo", label: "Pair" }, { key: "n", label: "Sample" }, { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" },
        { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }
    ]);
    md += `\n### Pairs - Top Losing\n\n`;
    md += mdTable(s.sectionB_combinations.pairs.top20Worst, [
        { key: "combo", label: "Pair" }, { key: "n", label: "Sample" }, { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" },
        { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }
    ]);
    md += `\n### Triplets - Top Winning\n\n`;
    md += mdTable(s.sectionB_combinations.triplets.top20Best, [
        { key: "combo", label: "Triplet" }, { key: "n", label: "Sample" }, { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" },
        { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }
    ]);
    md += `\n### Triplets - Top Losing\n\n`;
    md += mdTable(s.sectionB_combinations.triplets.top20Worst, [
        { key: "combo", label: "Triplet" }, { key: "n", label: "Sample" }, { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" },
        { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }
    ]);

    md += `\n## Section C: False Positive Analyzer (confidence >= 50 AND ROI < 0)\n\n`;
    md += mdTable(s.sectionC_falsePositiveTrades, [
        { key: "tokenSymbol", label: "Token" }, { key: "confidence", label: "Confidence" }, { key: "roiPct", label: "ROI %" },
        { key: "holdingTime", label: "Holding Time" }, { key: "reasons", label: "Reasons" }, { key: "exitReason", label: "Exit Reason" }
    ]);

    md += `\n## Section D: False Negative Analyzer\n\n`;
    if(!s.sectionD_falseNegativePredictions.available){
        md += `**${s.sectionD_falseNegativePredictions.message}**\n\n`;
    }
    else{
        md += `${s.sectionD_falseNegativePredictions.source}\n\nTarget movement: >= ${s.sectionD_falseNegativePredictions.targetMovementPct}% (mfe_pct). ${s.sectionD_falseNegativePredictions.definition}\n\n`;
        md += mdTable(s.sectionD_falseNegativePredictions.rows, [
            { key: "tokenSymbol", label: "Token" }, { key: "recommendation", label: "Recommendation" }, { key: "confidence", label: "Confidence" },
            { key: "mfePct", label: "MFE %" }, { key: "status", label: "Status" }, { key: "closeReason", label: "Close Reason" }
        ]);
    }

    md += `\n## Section E: Feature Recommendation\n\n`;
    md += mdTable(s.sectionE_featureRecommendation, [
        { key: "feature", label: "Feature" }, { key: "trades", label: "Trades" }, { key: "winRatePct", label: "Win Rate %" },
        { key: "avgRoiPct", label: "Avg ROI %" }, { key: "recommendation", label: "Recommendation" }
    ]);

    md += `\n## Section F: Confidence Calibration (extended)\n\n`;
    md += mdTable(s.sectionF_confidenceCalibration.buckets, [
        { key: "bucket", label: "Confidence" }, { key: "n", label: "Trades" }, { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" },
        { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }, { key: "totalPnlContributionUsd", label: "Total PnL (USD)" }
    ]);

    return md;
}

function csvEscape(v){
    if(v == null) return "";
    const s = String(v);
    if(/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

// One CSV file, multiple tables: each block is a "# Section ..." single-
// cell title row, a header row, its data rows, then a blank line. Not
// strictly single-schema CSV, but every spreadsheet tool (and the plain
// eye) reads this convention fine, and it's the only way to satisfy
// "one .csv file" while adding Sections A-G without discarding the
// original trade-level export (per this sprint's own "tambahkan, jangan
// hapus" instruction).
function csvBlock(title, rows, columns){
    const lines = [csvEscape(`# ${title}`)];
    lines.push(columns.map(c => csvEscape(c.label)).join(","));
    for(const row of rows) lines.push(columns.map(c => csvEscape(row[c.key])).join(","));
    lines.push("");
    return lines.join("\n");
}

function renderCsv(report){
    const s = report.sections;
    const columns = [
        "id", "user_id", "token_address", "token_symbol", "opened_at", "closed_at",
        "duration_seconds", "size_usd", "roi_pct", "realized_pnl_usd", "fee_usd",
        "exit_reason", "confidence", "risk", "rank_at_entry", "priority_score_at_entry",
        "reasons", "position_id", "engine_version"
    ];
    const lines = [columns.join(",")];
    for(const t of report.tradesForCsv){
        const feats = extractFeatures(t, "reasons");
        const row = {
            ...t,
            realized_pnl_usd: round(realizedPnl(t), 4),
            reasons: feats ? feats.join("; ") : ""
        };
        lines.push(columns.map(c => csvEscape(row[c])).join(","));
    }
    lines.push("");

    let out = lines.join("\n");

    out += csvBlock("Section A: Feature Forensic Ranking", s.sectionA_featureForensicRanking.positiveFeatures.rows, [
        { key: "feature", label: "Feature" }, { key: "n", label: "Trades" }, { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" },
        { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" },
        { key: "avgHoldingTime", label: "Avg Holding" }, { key: "totalPnlContributionUsd", label: "Total PnL USD" }
    ]);
    out += csvBlock("Section B: Pair Combinations - Top Winning", s.sectionB_combinations.pairs.top20Best, [
        { key: "combo", label: "Pair" }, { key: "n", label: "Sample" }, { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" },
        { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }
    ]);
    out += csvBlock("Section B: Pair Combinations - Top Losing", s.sectionB_combinations.pairs.top20Worst, [
        { key: "combo", label: "Pair" }, { key: "n", label: "Sample" }, { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" },
        { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }
    ]);
    out += csvBlock("Section B: Triplet Combinations - Top Winning", s.sectionB_combinations.triplets.top20Best, [
        { key: "combo", label: "Triplet" }, { key: "n", label: "Sample" }, { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" },
        { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }
    ]);
    out += csvBlock("Section B: Triplet Combinations - Top Losing", s.sectionB_combinations.triplets.top20Worst, [
        { key: "combo", label: "Triplet" }, { key: "n", label: "Sample" }, { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" },
        { key: "winRatePct", label: "Win Rate %" }, { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }
    ]);
    out += csvBlock("Section C: False Positives (confidence>=50 AND ROI<0)", s.sectionC_falsePositiveTrades, [
        { key: "tokenSymbol", label: "Token" }, { key: "confidence", label: "Confidence" }, { key: "roiPct", label: "ROI %" },
        { key: "holdingTime", label: "Holding Time" }, { key: "reasons", label: "Reasons" }, { key: "exitReason", label: "Exit Reason" }
    ]);
    out += csvBlock(
        "Section D: False Negatives",
        s.sectionD_falseNegativePredictions.available ? s.sectionD_falseNegativePredictions.rows : [{ tokenSymbol: s.sectionD_falseNegativePredictions.message }],
        s.sectionD_falseNegativePredictions.available
            ? [
                { key: "tokenSymbol", label: "Token" }, { key: "recommendation", label: "Recommendation" }, { key: "confidence", label: "Confidence" },
                { key: "mfePct", label: "MFE %" }, { key: "status", label: "Status" }, { key: "closeReason", label: "Close Reason" }
            ]
            : [{ key: "tokenSymbol", label: "INSUFFICIENT_DATA" }]
    );
    out += csvBlock("Section E: Feature Recommendation", s.sectionE_featureRecommendation, [
        { key: "feature", label: "Feature" }, { key: "trades", label: "Trades" }, { key: "winRatePct", label: "Win Rate %" },
        { key: "avgRoiPct", label: "Avg ROI %" }, { key: "recommendation", label: "Recommendation" }
    ]);
    out += csvBlock("Section F: Confidence Calibration", s.sectionF_confidenceCalibration.buckets, [
        { key: "bucket", label: "Confidence" }, { key: "n", label: "Trades" }, { key: "wins", label: "Wins" }, { key: "losses", label: "Losses" },
        { key: "avgRoiPct", label: "Avg ROI %" }, { key: "medianRoiPct", label: "Median ROI %" }, { key: "totalPnlContributionUsd", label: "Total PnL USD" }
    ]);

    return out;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

function main(){
    const report = buildReport();

    console.log("\n=== AI Performance Audit ===");
    console.log("Generated:", report.generatedAt);
    console.log("User filter:", report.userFilter ?? "(none - see per-user_id breakdown)");
    console.log("\nUser_id breakdown (trading_bot_trades):");
    console.table(report.userBreakdown);
    console.log("\nSection 1 - Overall Performance:");
    console.table([report.sections.overallPerformance]);
    console.log("\nSection 2 - Confidence Calibration:");
    console.table(report.sections.confidenceCalibration.buckets);
    console.log("\nSection 11 - Prediction Accuracy (platform-wide, see report for definition):");
    console.table([report.sections.predictionAccuracy]);
    console.log(`\nFull report: ${report.sections.topWinners.length} winners, ${report.sections.topLosers.length} losers, ${report.sections.featureCombinations.eligibleCombos} eligible feature combos.`);

    console.log("\n=== AI Feature Forensic Analyzer (Sections A-G) ===");
    console.log("Section A - Feature Forensic Ranking:");
    console.table(report.sections.sectionA_featureForensicRanking.positiveFeatures.rows);
    console.log(`Section B - Combinations: ${report.sections.sectionB_combinations.pairs.eligibleCombos} eligible pairs, ${report.sections.sectionB_combinations.triplets.eligibleCombos} eligible triplets.`);
    console.log(`Section C - False Positives (confidence>=50, ROI<0): ${report.sections.sectionC_falsePositiveTrades.length} trade(s).`);
    console.log(
        report.sections.sectionD_falseNegativePredictions.available
            ? `Section D - False Negatives: ${report.sections.sectionD_falseNegativePredictions.rows.length} token(s) found.`
            : `Section D - False Negatives: ${report.sections.sectionD_falseNegativePredictions.message}`
    );
    console.log("Section E - Feature Recommendation:");
    console.table(report.sections.sectionE_featureRecommendation);

    fs.mkdirSync(REPORTS_DIR, { recursive: true });

    const mdPath = path.join(REPORTS_DIR, "ai-performance-report.md");
    const jsonPath = path.join(REPORTS_DIR, "ai-performance-report.json");
    const csvPath = path.join(REPORTS_DIR, "ai-performance-report.csv");

    fs.writeFileSync(mdPath, renderMarkdown(report), "utf8");
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
    fs.writeFileSync(csvPath, renderCsv(report), "utf8");

    console.log(`\nWritten:\n  ${mdPath}\n  ${jsonPath}\n  ${csvPath}`);

    db.close();
}

main();
