// repositories/tradingBotRepository.js - the only file that touches
// trading_bot_state/config/positions/trades/log/equity_snapshot tables.
//
// Sprint A, Goal 2 (auth/multi-tenancy foundation): every function now
// takes a leading userId and scopes its query by it - trading_bot_state/
// config's PK is user_id (migration 035), and positions/trades/log/
// equity_snapshot each gained a nullable user_id column (existing rows
// left at NULL - archived/orphaned pre-Sprint-A data, per the CTO's
// decision that Goal 1's profit-proof must start from a clean state per
// user, never see it).
//
// forUser(userId) returns the exact shared-shape view
// (insertPosition/updatePositionTracking/closePosition/insertLog/
// findOpenPositionForToken/findLastTradeForToken) that
// services/tradeManager.js's createTradeManager() and
// services/entryGateService.js's createEntryGateService() already
// support unmodified - copied directly from
// repositories/benchmarkPositionRepository.js's own forParticipant(),
// the exact seam the Benchmark Harness already proved works for
// exactly this purpose (see the Sprint A plan).

const db = require("../database/connection");

function getState(userId){
    return db.prepare("SELECT * FROM trading_bot_state WHERE user_id = ?").get(userId);
}

const updateStateStmt = db.prepare(`
    UPDATE trading_bot_state
    SET status = @status, mode = @mode, last_action = @lastAction,
        running_since = @runningSince, last_action_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = @userId
`);

// running_since (migration 035): set on a STOPPED/PAUSED -> RUNNING
// transition, cleared on STOP - last_action_at resets on every
// pause/resume so it can't answer "how long has this user's profit-
// proof actually been running" (Sprint A Goal 1's own equity-curve
// endpoint needs this).
function updateState(userId, { status, mode, lastAction }){
    const current = getState(userId);
    const nextStatus = status ?? current.status;
    let runningSince = current.running_since;
    if(nextStatus === "RUNNING" && current.status !== "RUNNING") runningSince = new Date().toISOString().slice(0, 19).replace("T", " ");
    else if(nextStatus === "STOPPED") runningSince = null;
    updateStateStmt.run({
        userId,
        status: nextStatus,
        mode: mode ?? current.mode,
        lastAction: lastAction ?? current.last_action,
        runningSince
    });
    return getState(userId);
}

function getConfig(userId){
    return db.prepare("SELECT * FROM trading_bot_config WHERE user_id = ?").get(userId);
}

const CONFIG_FIELDS = [
    "initial_capital", "position_size_pct", "max_position_size", "max_open_positions",
    "min_order_size", "fee_pct", "slippage_pct", "one_position_per_token", "scan_interval_seconds",
    "min_confidence", "min_decay_fraction",
    "cooldown_win_minutes", "cooldown_loss_minutes", "cooldown_reversal_minutes", "cooldown_default_minutes",
    "execution_mode",
    // Strategy Profile (Constitution v1.0 / Final Spec section 02) -
    // strategy_profile is the one user-facing control; the two ON/OFF
    // flags are part of the profile bundle (config/strategyProfileConfig.js)
    // and are only ever written here as a side effect of a profile change -
    // see services/tradingBotService.js's updateConfig for that rule.
    "strategy_profile", "opportunity_priority_enabled", "emi_enabled",
    // Profile-Aware Production V2 refactor: engine/gate/exit override
    // fields, same "only via profile switch" rule. weights_json/tiers_json/
    // quality_gate_overrides_json/stop_loss_overrides_json store JSON
    // text (see normalizeJsonConfigFields below) - the rest are plain columns.
    "weights_json", "tiers_json", "min_liquidity_usd", "min_volume_usd", "flatten_earliness", "sm_bonus",
    "quality_gate_overrides_json", "fixed_tp_pct", "stop_loss_overrides_json", "momentum_weakening_buyer_dominance_ratio",
    "acceleration_overrides_json"
];

// strategyProfileConfig.js's bundles (and any caller building a partial
// update by hand) use natural, readable object fields (weights, tiers,
// quality_gate_overrides, stop_loss_overrides) - this is the one place
// that serializes them to the *_json TEXT columns SQLite actually
// stores, so better-sqlite3 never gets handed a raw object as a bound
// parameter. `null` serializes to `null` (clears/keeps-absent), not
// the string "null".
const JSON_FIELD_MAP = [
    ["weights", "weights_json"],
    ["tiers", "tiers_json"],
    ["quality_gate_overrides", "quality_gate_overrides_json"],
    ["stop_loss_overrides", "stop_loss_overrides_json"],
    ["acceleration_overrides", "acceleration_overrides_json"]
];

function normalizeJsonConfigFields(partial){
    const normalized = { ...partial };
    for(const [objectKey, jsonKey] of JSON_FIELD_MAP){
        if(normalized[objectKey] === undefined) continue;
        normalized[jsonKey] = normalized[objectKey] == null ? null : JSON.stringify(normalized[objectKey]);
        delete normalized[objectKey];
    }
    return normalized;
}

// These columns are the only ones declared nullable in the schema
// (migration 029) - "no override, use the engine's own default" is a
// real, meaningful value for them (e.g. STABLE's bundle sets
// min_liquidity_usd:null on purpose). For these specifically, "the key
// is present in partial" (including an explicit null) means "set it" -
// unlike every other CONFIG_FIELDS entry, where only a genuinely
// provided (non-null) value overrides the current row. Scoped narrowly
// so this fix cannot change behavior for any pre-existing field.
const NULLABLE_OVERRIDE_FIELDS = [
    "weights_json", "tiers_json", "min_liquidity_usd", "min_volume_usd",
    "quality_gate_overrides_json", "stop_loss_overrides_json", "acceleration_overrides_json"
];

function updateConfig(userId, partial){
    const current = getConfig(userId);
    const normalizedPartial = normalizeJsonConfigFields(partial);
    const merged = { userId };
    for(const field of CONFIG_FIELDS){
        if(NULLABLE_OVERRIDE_FIELDS.includes(field)){
            merged[field] = normalizedPartial[field] !== undefined ? normalizedPartial[field] : current[field];
        }
        else{
            merged[field] = normalizedPartial[field] != null ? normalizedPartial[field] : current[field];
        }
    }
    db.prepare(`
        UPDATE trading_bot_config SET
            initial_capital = @initial_capital,
            position_size_pct = @position_size_pct,
            max_position_size = @max_position_size,
            max_open_positions = @max_open_positions,
            min_order_size = @min_order_size,
            fee_pct = @fee_pct,
            slippage_pct = @slippage_pct,
            one_position_per_token = @one_position_per_token,
            scan_interval_seconds = @scan_interval_seconds,
            min_confidence = @min_confidence,
            min_decay_fraction = @min_decay_fraction,
            cooldown_win_minutes = @cooldown_win_minutes,
            cooldown_loss_minutes = @cooldown_loss_minutes,
            cooldown_reversal_minutes = @cooldown_reversal_minutes,
            cooldown_default_minutes = @cooldown_default_minutes,
            execution_mode = @execution_mode,
            strategy_profile = @strategy_profile,
            opportunity_priority_enabled = @opportunity_priority_enabled,
            emi_enabled = @emi_enabled,
            weights_json = @weights_json,
            tiers_json = @tiers_json,
            min_liquidity_usd = @min_liquidity_usd,
            min_volume_usd = @min_volume_usd,
            flatten_earliness = @flatten_earliness,
            sm_bonus = @sm_bonus,
            quality_gate_overrides_json = @quality_gate_overrides_json,
            fixed_tp_pct = @fixed_tp_pct,
            stop_loss_overrides_json = @stop_loss_overrides_json,
            momentum_weakening_buyer_dominance_ratio = @momentum_weakening_buyer_dominance_ratio,
            acceleration_overrides_json = @acceleration_overrides_json,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = @userId
    `).run(merged);
    return getConfig(userId);
}

// CRAB User Journey v1 (locked) - allocation_pct and the initial_capital
// it derives are owned exclusively by this function, never the generic
// updateConfig/CONFIG_FIELDS path above (the same "only via its own
// flow" convention strategy_profile-owned fields already follow).
// initial_capital is passed in pre-computed (deposited_balance_usd *
// allocation_pct / 100) by services/tradingBotService.js's
// setAllocation() - this repository never does that arithmetic
// itself, so there is exactly one place (the service layer) that ever
// computes it.
//
// allocation_set_at is stamped here ONLY - this function is called
// exclusively from the explicit setAllocation() action (the user
// actually choosing a percentage), never from a deposit/withdraw-
// triggered recompute (see updateInitialCapital below, which those use
// instead) - stamping it here would otherwise falsely mark "the user
// confirmed their allocation" every time they just deposited more
// money, which they didn't do.
const setAllocationStmt = db.prepare(`
    UPDATE trading_bot_config SET allocation_pct = @allocationPct, initial_capital = @initialCapital, allocation_set_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = @userId
`);

function setAllocationAndCapital(userId, allocationPct, initialCapital){
    setAllocationStmt.run({ userId, allocationPct, initialCapital });
    return getConfig(userId);
}

// Deposit/withdraw (services/walletService.js) recompute initial_capital
// from the EXISTING allocation_pct - the percentage itself didn't
// change, so allocation_set_at must not be touched here (see the
// comment above setAllocationStmt for why).
const updateInitialCapitalStmt = db.prepare(`
    UPDATE trading_bot_config SET initial_capital = @initialCapital, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = @userId
`);

function updateInitialCapital(userId, initialCapital){
    updateInitialCapitalStmt.run({ userId, initialCapital });
    return getConfig(userId);
}

// Stamped only when services/tradingBotService.js's updateConfig()
// actually receives a strategy_profile switch in the request - never
// on a generic config save (Advanced Settings' slippage/execution-mode
// edits never include strategy_profile at all, so they never touch
// this). strategy_profile defaults to STABLE, so - same reasoning as
// allocation_set_at - a value-based check can't tell a deliberate
// choice from an untouched default; this timestamp can.
function markStrategySelected(userId){
    db.prepare("UPDATE trading_bot_config SET strategy_selected_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(userId);
}

// Seeds a default trading_bot_state/config row for a brand new user -
// same defaults migration 016_trading_bot.sql used to seed the old
// singleton row (STOPPED/SIMULATION state, all-default config columns).
// Called once from services/userAuthService.js's register(), idempotent
// (INSERT OR IGNORE) as a defensive fallback.
const ensureStateStmt = db.prepare(
    "INSERT OR IGNORE INTO trading_bot_state (user_id, status, mode) VALUES (?, 'STOPPED', 'SIMULATION')"
);
const ensureConfigStmt = db.prepare(
    "INSERT OR IGNORE INTO trading_bot_config (user_id) VALUES (?)"
);

function ensureBotForUser(userId){
    ensureStateStmt.run(userId);
    ensureConfigStmt.run(userId);
}

// Powers scheduler/tradingBotScheduler.js's per-tick fan-out - only
// users whose bot is actually RUNNING get a cycle this tick.
function findRunningUserIds(){
    return db.prepare("SELECT user_id FROM trading_bot_state WHERE status = 'RUNNING'").all().map(r => r.user_id);
}

function findOpenPositions(userId){
    return db.prepare("SELECT * FROM trading_bot_positions WHERE user_id = ? AND status = 'OPEN' ORDER BY opened_at DESC").all(userId);
}

const findOpenPositionForTokenStmt = db.prepare(
    "SELECT * FROM trading_bot_positions WHERE user_id = ? AND token_address = ? AND status = 'OPEN'"
);

function findOpenPositionForToken(userId, tokenAddress){
    return findOpenPositionForTokenStmt.get(userId, tokenAddress);
}

function countOpenPositions(userId){
    return db.prepare("SELECT COUNT(*) as c FROM trading_bot_positions WHERE user_id = ? AND status = 'OPEN'").get(userId).c;
}

// Dynamic re-entry cooldown (Phase 5) reads from here - the real,
// already-recorded close of the MOST RECENT trade for this exact
// token, whatever the outcome. No new tracking table: trading_bot_trades
// is already the one real record of "when did we last close this token
// and why".
const findLastTradeForTokenStmt = db.prepare(
    "SELECT * FROM trading_bot_trades WHERE user_id = ? AND token_address = ? ORDER BY closed_at DESC LIMIT 1"
);

function findLastTradeForToken(userId, tokenAddress){
    return findLastTradeForTokenStmt.get(userId, tokenAddress);
}

const insertPositionStmt = db.prepare(`
    INSERT INTO trading_bot_positions (
        user_id, token_address, token_symbol, entry_price, current_price, size_usd,
        confidence, exit_strategy, engine_version,
        target_price, target_market_cap, stop_loss_price, stop_loss_market_cap,
        last_volume_1h, status, execution_id
    ) VALUES (
        @userId, @tokenAddress, @tokenSymbol, @entryPrice, @entryPrice, @sizeUsd,
        @confidence, @exitStrategy, @engineVersion,
        @targetPrice, @targetMarketCap, @stopLossPrice, @stopLossMarketCap,
        @lastVolume1h, 'OPEN', @executionId
    )
`);

// executionId (migration 046) is nullable and defaults to null here -
// only services/tradeManager.js's real (Sprint 2, Founder Decision Path A)
// open path ever passes one; every SIMULATION-mode/benchmark/ab-test
// caller keeps writing null, exactly as before this column existed.
function insertPosition(userId, row){
    const info = insertPositionStmt.run({ lastVolume1h: null, executionId: null, ...row, userId });
    return info.lastInsertRowid;
}

const updatePositionTrackingStmt = db.prepare(`
    UPDATE trading_bot_positions
    SET current_price = @currentPrice, mfe_pct = @mfePct, mae_pct = @maePct, last_volume_1h = @lastVolume1h
    WHERE id = @id
`);

function updatePositionTracking(id, { currentPrice, mfePct, maePct, lastVolume1h }){
    updatePositionTrackingStmt.run({ id, currentPrice, mfePct, maePct, lastVolume1h: lastVolume1h ?? null });
}

const closePositionStmt = db.prepare(`
    UPDATE trading_bot_positions SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = ?
`);

const insertTradeStmt = db.prepare(`
    INSERT INTO trading_bot_trades (
        user_id, token_address, token_symbol, entry_price, exit_price, size_usd,
        roi_pct, fee_usd, slippage_pct, duration_seconds, reason,
        engine_version, opened_at, closed_at, tx_hash, open_execution_id, close_execution_id
    ) VALUES (
        @userId, @tokenAddress, @tokenSymbol, @entryPrice, @exitPrice, @sizeUsd,
        @roiPct, @feeUsd, @slippagePct, @durationSeconds, @reason,
        @engineVersion, @openedAt, CURRENT_TIMESTAMP, @txHash, @openExecutionId, @closeExecutionId
    )
`);

// txHash/openExecutionId/closeExecutionId (migration 045/046) default to
// null - only a real (Sprint 2, Founder Decision Path A) close passes
// them; every SIMULATION-mode/benchmark/ab-test caller keeps writing
// null, exactly as before these columns existed. openExecutionId comes
// from the position's own execution_id (the BUY that opened it);
// closeExecutionId and txHash describe the SELL that's closing it now.
function closePosition(userId, position, { exitPrice, roiPct, feeUsd, slippagePct, durationSeconds, reason, txHash, closeExecutionId }){
    const tx = db.transaction(() => {
        closePositionStmt.run(position.id);
        insertTradeStmt.run({
            userId,
            tokenAddress: position.token_address,
            tokenSymbol: position.token_symbol,
            entryPrice: position.entry_price,
            exitPrice,
            sizeUsd: position.size_usd,
            roiPct,
            feeUsd,
            slippagePct,
            durationSeconds,
            reason,
            engineVersion: position.engine_version,
            openedAt: position.opened_at,
            txHash: txHash ?? null,
            openExecutionId: position.execution_id ?? null,
            closeExecutionId: closeExecutionId ?? null
        });
    });
    tx();
}

function findRecentTrades(userId, limit){
    return db.prepare("SELECT * FROM trading_bot_trades WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit || 100);
}

function countTrades(userId){
    return db.prepare("SELECT COUNT(*) as c FROM trading_bot_trades WHERE user_id = ?").get(userId).c;
}

function findRecentLog(userId, limit){
    return db.prepare("SELECT * FROM trading_bot_log WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(userId, limit || 100);
}

const insertLogStmt = db.prepare(`
    INSERT INTO trading_bot_log (user_id, log_type, token_symbol, message, meta_json)
    VALUES (@userId, @logType, @tokenSymbol, @message, @metaJson)
`);

function insertLog(userId, { logType, tokenSymbol, message, meta }){
    insertLogStmt.run({
        userId,
        logType,
        tokenSymbol: tokenSymbol ?? null,
        message,
        metaJson: meta ? JSON.stringify(meta) : null
    });
}

// realizedPnl is NET of fees (size_usd*roi_pct/100 - fee_usd per trade, summed) -
// matches abTestRepository.js's summarize(), the one place in this codebase that
// already got this right. totalFees is still reported separately for transparency,
// but must never be added back into realizedPnl/availableCash/equity by a caller.
function sumClosedTrades(userId){
    return db.prepare(`
        SELECT
            COUNT(*) as closedCount,
            COALESCE(SUM(CASE WHEN roi_pct > 0 THEN 1 ELSE 0 END), 0) as winCount,
            COALESCE(SUM(CASE WHEN roi_pct <= 0 THEN 1 ELSE 0 END), 0) as lossCount,
            COALESCE(SUM((size_usd * roi_pct / 100.0) - fee_usd), 0) as realizedPnl,
            COALESCE(SUM(fee_usd), 0) as totalFees,
            COALESCE(SUM(CASE WHEN roi_pct > 0 THEN (size_usd * roi_pct / 100.0) ELSE 0 END), 0) as grossWin,
            COALESCE(SUM(CASE WHEN roi_pct <= 0 THEN ABS(size_usd * roi_pct / 100.0) ELSE 0 END), 0) as grossLoss
        FROM trading_bot_trades
        WHERE user_id = ? AND closed_at IS NOT NULL
    `).get(userId);
}

function sumOpenPositions(userId){
    return db.prepare(`
        SELECT
            COUNT(*) as openCount,
            COALESCE(SUM(size_usd), 0) as openValueAtEntry,
            COALESCE(SUM(size_usd * (COALESCE(current_price, entry_price) / entry_price)), 0) as openMarketValue
        FROM trading_bot_positions
        WHERE user_id = ? AND status = 'OPEN'
    `).get(userId);
}

// Same convention as abTestRepository's ab_test_equity_snapshot handling
// (023_ab_test.sql) - one row per cycle, real max drawdown from a real
// recorded curve, never a synthetic estimate. See migration 033.
const insertEquitySnapshotStmt = db.prepare(
    "INSERT INTO trading_bot_equity_snapshot (user_id, equity) VALUES (?, ?)"
);

function insertEquitySnapshot(userId, equity){
    insertEquitySnapshotStmt.run(userId, equity);
}

function findEquityCurve(userId){
    return db.prepare("SELECT equity, taken_at FROM trading_bot_equity_snapshot WHERE user_id = ? ORDER BY taken_at ASC").all(userId);
}

function computeMaxDrawdownPct(userId){
    const curve = findEquityCurve(userId);
    if(curve.length < 2) return null;
    let peak = curve[0].equity;
    let maxDd = 0;
    for(const point of curve){
        peak = Math.max(peak, point.equity);
        const dd = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
        maxDd = Math.max(maxDd, dd);
    }
    return maxDd;
}

// The shared-shape view services/tradeManager.js and
// services/entryGateService.js actually consume - copied directly from
// repositories/benchmarkPositionRepository.js's own forParticipant(),
// the exact seam the Benchmark Harness already proved works for this.
function forUser(userId){
    return {
        insertPosition: (row) => insertPosition(userId, row),
        updatePositionTracking,
        closePosition: (position, outcome) => closePosition(userId, position, outcome),
        insertLog: (entry) => insertLog(userId, entry),
        findOpenPositionForToken: (tokenAddress) => findOpenPositionForToken(userId, tokenAddress),
        findLastTradeForToken: (tokenAddress) => findLastTradeForToken(userId, tokenAddress)
    };
}

module.exports = {
    getState, updateState,
    getConfig, updateConfig, setAllocationAndCapital, updateInitialCapital, markStrategySelected,
    ensureBotForUser, findRunningUserIds,
    findOpenPositions, findOpenPositionForToken, countOpenPositions,
    findLastTradeForToken,
    insertPosition, updatePositionTracking, closePosition,
    findRecentTrades, countTrades,
    findRecentLog, insertLog,
    sumClosedTrades, sumOpenPositions,
    insertEquitySnapshot, findEquityCurve, computeMaxDrawdownPct,
    forUser
};
