// scripts/regressionCompare/compare.js - Regression Comparator.
//
// Reads the two REAL telemetry dumps produced by runBaseline.js (run
// inside a worktree checked out at a0a8759) and runHead.js (run in this
// checkout), and reports a scientific, runtime-measured comparison -
// never an estimate, never a static-audit inference. Every number here
// comes directly from real Date.now() timestamps recorded while the
// real, unmodified production functions from each commit actually ran.
//
// See this directory's own README section at the bottom of this file
// for exactly how to (re)produce both telemetry files from scratch.

const fs = require("fs");
const path = require("path");

const HEAD_PATH = path.join(__dirname, "telemetry-head.json");
const BASELINE_PATH = path.join(__dirname, "telemetry-baseline.json");

// isolation-test addition: an explicit label describing WHAT was
// compared, derived from the telemetry file's own real metadata
// (engineVersion + heldPositionRefreshMode, when present) rather than
// hardcoded "Arjuna"/"HEAD" - so this same comparator also reports
// correctly for a Mode A vs Mode B run (same HEAD codebase, different
// config.HELD_POSITION_REFRESH_MODE), not only the original
// baseline-commit-vs-HEAD comparison.
function describeRun(raw){
    const mode = raw.heldPositionRefreshMode ? ` (HELD_POSITION_REFRESH_MODE=${raw.heldPositionRefreshMode})` : "";
    return `${raw.engineVersion || "unknown"}${mode}`;
}

function loadTelemetry(filePath, label){

    if(!fs.existsSync(filePath)){
        console.error(`[regression-compare] Missing ${filePath} - run the ${label} harness first (see this file's own header/README).`);
        process.exit(1);
    }

    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
        label: describeRun(raw),
        records: raw.telemetry.slice().sort((a, b) => a.request_start - b.request_start)
    };

}

function computeMetrics(records){

    if(!records.length){
        return { totalRequests: 0, perEndpoint: {}, qps: 0, maxBurstIn1s: 0, tightestBurst: null, maxConcurrent: 0, totalDurationMs: 0 };
    }

    const totalRequests = records.length;

    const perEndpoint = {};
    for(const r of records){
        perEndpoint[r.endpoint] = (perEndpoint[r.endpoint] || 0) + 1;
    }

    const minStart = Math.min(...records.map(r => r.request_start));
    const maxFinish = Math.max(...records.map(r => r.request_finish));
    const totalDurationMs = Math.max(1, maxFinish - minStart);

    const qps = Math.round((totalRequests / (totalDurationMs / 1000)) * 100) / 100;

    // Largest burst: max number of requests whose real request_start
    // falls within ANY real 1000ms sliding window.
    const starts = records.map(r => r.request_start).sort((a, b) => a - b);
    let maxBurstIn1s = 1;
    for(let i = 0; i < starts.length; i++){
        let count = 1;
        for(let j = i + 1; j < starts.length && starts[j] - starts[i] <= 1000; j++) count++;
        if(count > maxBurstIn1s) maxBurstIn1s = count;
    }

    // Tightest real cluster: the smallest real ms span that contains the
    // most requests found above - the "N request dalam M ms" figure.
    let tightestBurst = null;
    for(let i = 0; i < starts.length; i++){
        const windowEnd = i + maxBurstIn1s - 1;
        if(windowEnd < starts.length && starts[windowEnd] - starts[i] <= 1000){
            const span = starts[windowEnd] - starts[i];
            if(!tightestBurst || span < tightestBurst.spanMs){
                tightestBurst = { count: maxBurstIn1s, spanMs: span };
            }
        }
    }

    // Max concurrent: real sweep-line over [request_start, request_finish].
    const events = [];
    for(const r of records){
        events.push({ t: r.request_start, delta: 1 });
        events.push({ t: r.request_finish, delta: -1 });
    }
    events.sort((a, b) => a.t - b.t || a.delta - b.delta);
    let concurrent = 0, maxConcurrent = 0;
    for(const e of events){
        concurrent += e.delta;
        if(concurrent > maxConcurrent) maxConcurrent = concurrent;
    }

    return { totalRequests, perEndpoint, qps, maxBurstIn1s, tightestBurst, maxConcurrent, totalDurationMs };

}

function formatMetricsTable(leftMetrics, rightMetrics, leftLabel = "Left", rightLabel = "Right"){

    const rows = [
        ["Total request GMGN", leftMetrics.totalRequests, rightMetrics.totalRequests],
        ["Requests/detik (QPS)", leftMetrics.qps, rightMetrics.qps],
        ["Burst terbesar (dalam 1000ms)", leftMetrics.maxBurstIn1s, rightMetrics.maxBurstIn1s],
        ["Concurrent request maksimum", leftMetrics.maxConcurrent, rightMetrics.maxConcurrent],
        ["Total duration (ms)", leftMetrics.totalDurationMs, rightMetrics.totalDurationMs]
    ];

    const lines = [];
    lines.push("Metric".padEnd(32) + `| ${leftLabel}`.padEnd(20) + `| ${rightLabel}`.padEnd(12) + "| Delta");
    lines.push("-".repeat(80));
    for(const [metric, left, right] of rows){
        const rawDelta = typeof left === "number" && typeof right === "number" ? Math.round((right - left) * 100) / 100 : "-";
        const deltaStr = typeof rawDelta === "number" ? (rawDelta > 0 ? `+${rawDelta}` : `${rawDelta}`) : rawDelta;
        lines.push(String(metric).padEnd(32) + `| ${String(left).padEnd(18)}| ${String(right).padEnd(10)}| ${deltaStr}`);
    }

    lines.push("");
    lines.push("Request per endpoint:");
    const allEndpoints = new Set([...Object.keys(leftMetrics.perEndpoint), ...Object.keys(rightMetrics.perEndpoint)]);
    for(const ep of allEndpoints){
        const l = leftMetrics.perEndpoint[ep] || 0;
        const r = rightMetrics.perEndpoint[ep] || 0;
        const delta = r - l;
        lines.push(`  ${ep.padEnd(32)} ${leftLabel}=${l}  ${rightLabel}=${r}  Delta=${delta > 0 ? "+" + delta : delta}`);
    }

    return lines.join("\n");

}

function formatCallGraph(records, label){

    const lines = [label];
    records.forEach((r, i) => {
        lines.push(`  ${String(i + 1).padStart(2)}. [${r.origin}] ${r.endpoint}${r.candidate ? " " + JSON.stringify(r.candidate) : ""} (${r.status})`);
        if(i < records.length - 1){
            const gap = records[i + 1].request_start - r.request_start;
            lines.push(`      ↓ (+${gap}ms)`);
        }
    });
    return lines.join("\n");

}

function findFirstDifference(baseline, head){

    const shape = r => `${r.origin}::${r.endpoint}`;
    const baselineShapes = baseline.map(shape);
    const headShapes = head.map(shape);

    const maxLen = Math.max(baselineShapes.length, headShapes.length);

    for(let i = 0; i < maxLen; i++){

        const b = baselineShapes[i];
        const h = headShapes[i];

        if(b !== h){

            if(b === undefined){
                return { identical: false, index: i, reason: `HEAD punya ${headShapes.length - baselineShapes.length} request TAMBAHAN yang tidak ada di Arjuna, dimulai dari request ke-${i + 1}: [${head[i].origin}] ${head[i].endpoint}` };
            }
            if(h === undefined){
                return { identical: false, index: i, reason: `Arjuna punya ${baselineShapes.length - headShapes.length} request LEBIH BANYAK yang tidak ada di HEAD, dimulai dari request ke-${i + 1}: [${baseline[i].origin}] ${baseline[i].endpoint}` };
            }

            return {
                identical: false, index: i,
                reason: `Request ke-${i + 1} berbeda:\n    Arjuna: [${baseline[i].origin}] ${baseline[i].endpoint}\n    HEAD:   [${head[i].origin}] ${head[i].endpoint}`
            };

        }

    }

    return { identical: true };

}

function main(){

    // isolation-test addition: optional CLI args override which two
    // telemetry files get compared - `node compare.js <left> <right>` -
    // so the exact same tool also serves a Mode A vs Mode B comparison
    // (both HEAD, different config.HELD_POSITION_REFRESH_MODE), not only
    // the original baseline-commit-vs-HEAD comparison. Defaults preserve
    // every existing invocation unchanged.
    const leftPath = process.argv[2] ? path.resolve(process.argv[2]) : BASELINE_PATH;
    const rightPath = process.argv[3] ? path.resolve(process.argv[3]) : HEAD_PATH;

    const left = loadTelemetry(leftPath, "left-hand side");
    const right = loadTelemetry(rightPath, "right-hand side");

    const leftMetrics = computeMetrics(left.records);
    const rightMetrics = computeMetrics(right.records);

    console.log("=".repeat(80));
    console.log(`REGRESSION COMPARATOR - ${left.label}  vs  ${right.label}`);
    console.log("Berdasarkan runtime nyata (spyGmgnClient, tidak ada request GMGN sungguhan, tidak ada submit, tidak ada tulis DB nyata).");
    console.log("=".repeat(80));
    console.log("");
    console.log(formatMetricsTable(leftMetrics, rightMetrics, left.label, right.label));
    console.log("");
    console.log("=".repeat(80));
    console.log("CALL GRAPH");
    console.log("=".repeat(80));
    console.log(formatCallGraph(left.records, `${left.label}:`));
    console.log("");
    console.log(formatCallGraph(right.records, `${right.label}:`));
    console.log("");
    console.log("=".repeat(80));
    console.log("FIRST DIFFERENCE");
    console.log("=".repeat(80));

    const diff = findFirstDifference(left.records, right.records);
    if(diff.identical){
        console.log("Tidak ada perbedaan runtime - urutan (origin, endpoint) identik di kedua sisi.");
    }
    else{
        console.log(diff.reason);
    }

    console.log("");

}

if(require.main === module){
    main();
}

module.exports = { computeMetrics, formatMetricsTable, formatCallGraph, findFirstDifference };

// ============================================================
// CARA MENJALANKAN (framework lengkap, dari nol)
// ============================================================
//
// 1. Jalankan sisi HEAD (dari checkout ini):
//      cd server
//      node scripts/regressionCompare/runHead.js
//    -> menulis scripts/regressionCompare/telemetry-head.json
//
// 2. Siapkan worktree baseline (sekali saja, dari root repo):
//      git worktree add /tmp/regression-baseline a0a8759
//      cd /tmp/regression-baseline/server
//      ln -s "<path-checkout-ini>/server/node_modules" node_modules
//      node -e "require('./src/database/migrate').runMigrations();"
//    (membuat skema DB kosong yang terisolasi HANYA di dalam worktree
//    ini - tidak pernah menyentuh data/crabsem.sqlite yang asli)
//
// 3. Salin harness ke dalam worktree, lalu jalankan sisi baseline:
//      cp server/scripts/regressionCompare/{spyGmgnClient,fixture,runBaseline}.js \
//         /tmp/regression-baseline/server/scripts/regressionCompare/
//      cd /tmp/regression-baseline/server
//      node scripts/regressionCompare/runBaseline.js
//    -> menulis telemetry-baseline.json di dalam worktree
//
// 4. Salin telemetry-baseline.json kembali ke checkout ini, lalu
//    bandingkan:
//      cp /tmp/regression-baseline/server/scripts/regressionCompare/telemetry-baseline.json \
//         server/scripts/regressionCompare/
//      node server/scripts/regressionCompare/compare.js
//
// Untuk membandingkan commit BARU (bukan a0a8759) sebagai baseline:
// ganti "a0a8759" di langkah 2 dengan commit hash apapun, dan (jika
// signature fungsi produksi di commit itu berbeda dari yang diasumsikan
// runBaseline.js saat ini) sesuaikan runBaseline.js secukupnya.
