// repositories/tradingBotFreshUniverseSnapshotRepository.js - Fresh BUY
// Universe RFC, pipeline observability enhancement requested at
// approval. One row per scheduler tick showing the collector -> fresh
// universe stage of the funnel - the stage that had zero visibility
// before this sprint (the AI/entry-gate/open-position stages already
// have per-user observability via tradingBotRepository.insertLog()'s
// "Cycle complete"/"Filtering" rows). Written by
// scheduler/tradingBotScheduler.js's tick(), read by
// services/tradingBotService.js's getBottleneckReport(). Mirrors
// repositories/benchmarkFunnelRepository.js's shape, adapted to be
// tick-global (no user_id/participant scoping) since the fresh universe
// is built ONCE per tick, shared across every due user.

const db = require("../database/connection");

const insertSnapshotStmt = db.prepare(`
    INSERT INTO trading_bot_fresh_universe_snapshots (
        collector_total_count, fresh_universe_count, max_age_seconds, min_market_cap
    ) VALUES (
        @collectorTotalCount, @freshUniverseCount, @maxAgeSeconds, @minMarketCap
    )
`);

function insertSnapshot({ collectorTotalCount, freshUniverseCount, maxAgeSeconds, minMarketCap }){
    insertSnapshotStmt.run({ collectorTotalCount, freshUniverseCount, maxAgeSeconds, minMarketCap });
}

// Averaged (not summed) across ticks in the window - collector_total_count
// and fresh_universe_count are both point-in-time snapshots of the same
// gmgn_tokens table, not per-tick throughput, so summing them across N
// ticks would overcount by N. tickCount included so a 0-tick window
// (e.g. bot never ran) is distinguishable from a window with real
// ticks.
function sumSince(hours){
    return db.prepare(`
        SELECT
            COUNT(*) as tickCount,
            AVG(collector_total_count) as collectorTotalAvg,
            AVG(fresh_universe_count) as freshUniverseAvg
        FROM trading_bot_fresh_universe_snapshots
        WHERE taken_at >= datetime('now', '-' || @hours || ' hours')
    `).get({ hours });
}

module.exports = { insertSnapshot, sumSince };
