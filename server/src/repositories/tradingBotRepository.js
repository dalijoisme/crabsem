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
    // Trading Configuration sprint (migration 055): position_size_pct/
    // max_position_size/max_open_positions above are no longer
    // profile-owned (see services/tradingBotService.js's PROFILE_OWNED_FIELDS
    // and updateConfig) - position_sizing_mode/fixed_position_size_usd add
    // the fixed-USD sizing option alongside the existing percent mode.
    "position_sizing_mode", "fixed_position_size_usd",
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
    "quality_gate_overrides_json", "stop_loss_overrides_json", "acceleration_overrides_json",
    // fixed_position_size_usd (migration 055): null is a real, meaningful
    // "not using fixed-USD sizing" state, same convention min_liquidity_usd
    // already uses - never conflated with "no value provided, keep current."
    "fixed_position_size_usd"
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
            position_sizing_mode = @position_sizing_mode,
            fixed_position_size_usd = @fixed_position_size_usd,
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
// initial_capital is passed in pre-computed (real wallet balance x
// allocation_pct / 100, Production Stabilization V1 - previously the
// self-reported deposited_balance_usd) by services/tradingBotService.js's
// setAllocation() - this repository never does that arithmetic
// itself, so there is exactly one place (the service layer) that ever
// computes it.
//
// allocation_set_at is stamped here ONLY - this function is called
// exclusively from the explicit setAllocation() action (the user
// actually choosing a percentage), never from the periodic real-balance
// resync (see updateInitialCapital below, which that uses instead) -
// stamping it here would otherwise falsely mark "the user confirmed
// their allocation" every time their real wallet balance simply moved.
const setAllocationStmt = db.prepare(`
    UPDATE trading_bot_config SET allocation_pct = @allocationPct, initial_capital = @initialCapital, allocation_set_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = @userId
`);

function setAllocationAndCapital(userId, allocationPct, initialCapital){
    setAllocationStmt.run({ userId, allocationPct, initialCapital });
    return getConfig(userId);
}

// services/tradingBotService.js's getTradingConfiguration() write-through
// and scheduler/walletBalanceSyncScheduler.js's periodic sync both
// recompute initial_capital from the EXISTING allocation_pct against a
// freshly-read real wallet balance - the percentage itself didn't
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

// Trading Configuration sprint: same "stamped only on a deliberate user
// action" convention as markStrategySelected/allocation_set_at above -
// stamped whenever services/tradingBotService.js's updateConfig()
// actually receives a real change to position_size_pct/max_position_size/
// max_open_positions/position_sizing_mode/fixed_position_size_usd. Once
// set, a later strategy_profile switch must never silently overwrite
// those fields again - see updateConfig's own profile-switch branch.
function markTradingConfigCustomized(userId){
    db.prepare("UPDATE trading_bot_config SET trading_config_customized_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(userId);
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

// Scoped by user AND status='OPEN' - a manual-sell request can only ever
// target a position that's actually this user's own and still open,
// same safety property findOpenPositionForToken already has.
const findOpenPositionByIdStmt = db.prepare(
    "SELECT * FROM trading_bot_positions WHERE user_id = ? AND id = ? AND status = 'OPEN'"
);

function findOpenPositionById(userId, id){
    return findOpenPositionByIdStmt.get(userId, id);
}

// Position-detail view (Trust/UX sprint): unlike findOpenPositionById,
// no status filter - a closed position's detail must stay viewable
// after it closes, not disappear.
const findPositionByIdStmt = db.prepare(
    "SELECT * FROM trading_bot_positions WHERE user_id = ? AND id = ?"
);

function findPositionById(userId, id){
    return findPositionByIdStmt.get(userId, id);
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

// Position Detail's timeline (Live Decision Center / Signal Center
// sprint): the real trade row that closed THIS exact position, via
// migration 049's position_id FK - null for a still-OPEN position, or for
// a position closed before that migration existed (never guessed from
// token_address/opened_at instead).
const findTradeByPositionIdStmt = db.prepare(
    "SELECT * FROM trading_bot_trades WHERE user_id = ? AND position_id = ?"
);

function findTradeByPositionId(userId, positionId){
    return findTradeByPositionIdStmt.get(userId, positionId);
}

const insertPositionStmt = db.prepare(`
    INSERT INTO trading_bot_positions (
        user_id, token_address, token_symbol, entry_price, current_price, size_usd,
        confidence, exit_strategy, engine_version,
        target_price, target_market_cap, stop_loss_price, stop_loss_market_cap,
        last_volume_1h, status, execution_id, breakdown_json,
        rank_at_entry, priority_score_at_entry, risk, siblings_json, config_snapshot_json
    ) VALUES (
        @userId, @tokenAddress, @tokenSymbol, @entryPrice, @entryPrice, @sizeUsd,
        @confidence, @exitStrategy, @engineVersion,
        @targetPrice, @targetMarketCap, @stopLossPrice, @stopLossMarketCap,
        @lastVolume1h, 'OPEN', @executionId, @breakdownJson,
        @rankAtEntry, @priorityScoreAtEntry, @risk, @siblingsJson, @configSnapshotJson
    )
`);

// executionId (migration 046), breakdownJson (migration 047),
// rankAtEntry/priorityScoreAtEntry/risk (migration 048),
// siblingsJson (migration 051), and configSnapshotJson (migration 056)
// are nullable and default to null here - only services/tradeManager.js's
// real per-cycle path ever passes them; every SIMULATION-mode/benchmark/
// ab-test caller (whose signal stubs never set
// live.breakdown/rankAtEntry/risk/siblings, and whose config isn't a real
// trading_bot_config row) keeps writing null, exactly as before either
// column existed.
function insertPosition(userId, row){
    const info = insertPositionStmt.run({
        lastVolume1h: null, executionId: null, breakdownJson: null,
        rankAtEntry: null, priorityScoreAtEntry: null, risk: null, siblingsJson: null, configSnapshotJson: null,
        ...row, userId
    });
    return info.lastInsertRowid;
}

const updatePositionTrackingStmt = db.prepare(`
    UPDATE trading_bot_positions
    SET current_price = @currentPrice, mfe_pct = @mfePct, mae_pct = @maePct, last_volume_1h = @lastVolume1h,
        mfe_at = @mfeAt, mae_at = @maeAt, crossed_5pct_at = @crossed5pctAt, crossed_10pct_at = @crossed10pctAt,
        price_updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
`);

// mfeAt/maeAt (migration 048) and crossed5pctAt/crossed10pctAt (migration
// 051): the caller (services/tradeManager.js's closeIfDue, which already
// holds both the position's PREVIOUS values and the newly-computed one in
// scope) decides whether a new extreme/threshold-crossing was actually
// reached this call and passes the matching timestamp through - this
// function only ever persists what it's given, never recomputes or
// guesses one itself.
function updatePositionTracking(id, { currentPrice, mfePct, maePct, lastVolume1h, mfeAt, maeAt, crossed5pctAt, crossed10pctAt }){
    updatePositionTrackingStmt.run({
        id, currentPrice, mfePct, maePct, lastVolume1h: lastVolume1h ?? null,
        mfeAt: mfeAt ?? null, maeAt: maeAt ?? null,
        crossed5pctAt: crossed5pctAt ?? null, crossed10pctAt: crossed10pctAt ?? null
    });
}

// Production Stabilization V1 Final Sprint (Section I - Scheduler
// Safety): the WHERE clause below used to be a bare `WHERE id = ?`, with
// no status guard - closePosition() was NOT idempotent. The scheduler's
// own automatic closeIfDue() and the dashboard's manual forceSellAll/
// sellPosition (services/tradingBotService.js) are two genuinely
// independent call paths with no shared lock between them; if both
// reached the same OPEN position within the same real on-chain balance-
// check window (a real, awaited RPC round-trip, not instant), both could
// call closePosition() for the same position.id - the old UPDATE would
// silently re-fire for the second caller too, and insertTradeStmt below
// ran UNCONDITIONALLY regardless of whether the UPDATE actually changed
// anything, meaning a second call inserted a genuine DUPLICATE
// trading_bot_trades row (double-counted in Trade History, ROI/KPI
// aggregates, everywhere). `AND status = 'OPEN'` makes the UPDATE itself
// the real idempotency guard - a database CAN only transition a row
// from OPEN to CLOSED once, and closePosition() below now checks
// info.changes to know whether THIS call was the one that actually did it.
const closePositionStmt = db.prepare(`
    UPDATE trading_bot_positions SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'OPEN'
`);

const insertTradeStmt = db.prepare(`
    INSERT INTO trading_bot_trades (
        user_id, token_address, token_symbol, entry_price, exit_price, size_usd,
        roi_pct, fee_usd, slippage_pct, duration_seconds, reason,
        engine_version, opened_at, closed_at, tx_hash, open_execution_id, close_execution_id, position_id
    ) VALUES (
        @userId, @tokenAddress, @tokenSymbol, @entryPrice, @exitPrice, @sizeUsd,
        @roiPct, @feeUsd, @slippagePct, @durationSeconds, @reason,
        @engineVersion, @openedAt, CURRENT_TIMESTAMP, @txHash, @openExecutionId, @closeExecutionId, @positionId
    )
`);

// txHash/openExecutionId/closeExecutionId (migration 045/046) default to
// null - only a real (Sprint 2, Founder Decision Path A) close passes
// them; every SIMULATION-mode/benchmark/ab-test caller keeps writing
// null, exactly as before these columns existed. openExecutionId comes
// from the position's own execution_id (the BUY that opened it);
// closeExecutionId and txHash describe the SELL that's closing it now.
// Returns { closed: boolean } - false when this exact position was
// already CLOSED by a concurrent caller (the real, idempotent guard is
// closePositionStmt's own `AND status = 'OPEN'`, checked here via
// info.changes) - the trade row is only ever inserted once, by whichever
// caller's UPDATE genuinely won the race, never by both.
function closePosition(userId, position, { exitPrice, roiPct, feeUsd, slippagePct, durationSeconds, reason, txHash, closeExecutionId }){
    let closed = false;
    const tx = db.transaction(() => {
        const info = closePositionStmt.run(position.id);
        closed = info.changes > 0;
        if(!closed) return; // already closed by a concurrent caller - never a duplicate trade row
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
            closeExecutionId: closeExecutionId ?? null,
            // Live Decision Center / Signal Center sprint: real FK back to
            // the position this trade closed - Position Detail's timeline
            // joins on this instead of the (user_id, token_address,
            // opened_at) coincidence.
            positionId: position.id
        });
    });
    tx();
    return { closed };
}

function findRecentTrades(userId, limit){
    return db.prepare("SELECT * FROM trading_bot_trades WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit || 100);
}

// Momentum KPI sprint: every real trade, oldest first - Average Holding
// Time / Trades Per Hour / Closes Per Hour are all real GROUP BY-style
// arithmetic over opened_at/closed_at/duration_seconds, already fully
// populated columns, no new computation needed.
//
// Production Hotfix V1.1, Section 5: LIVE-only - close_execution_id
// IS NOT NULL is the same real signal (Production Stabilization V1)
// that already distinguishes a genuine real on-chain close from a
// SIMULATION-mode paper trade. This function feeds Momentum KPI, an
// explicit "Founder Live Trading evaluation" surface - a virtual
// SIMULATION trade (however realistic its own ROI% looks) must never
// count toward it. sumClosedTrades()/sumOpenPositions() below are
// DELIBERATELY left untouched - those feed getPortfolio(), the
// engine's own real-time ledger, which must keep reflecting a
// SIMULATION account's own paper P&L correctly regardless of mode.
function findAllTradesChronological(userId){
    return db.prepare("SELECT * FROM trading_bot_trades WHERE user_id = ? AND close_execution_id IS NOT NULL ORDER BY opened_at ASC").all(userId);
}

// Average Rank At Entry (Momentum KPI sprint) - real rank_at_entry values
// (migration 048), joined via each trade's own position_id (migration
// 049). Only ever non-null for a position opened after both migrations
// AND while Opportunity Priority was actually enabled for that cycle -
// every other trade is correctly excluded here, never counted as rank 0.
// LIVE-only (Production Hotfix V1.1, Section 5) - see the comment above
// findAllTradesChronological for why.
function findRankAtEntryValues(userId){
    return db.prepare(`
        SELECT p.rank_at_entry as rankAtEntry
        FROM trading_bot_trades t
        JOIN trading_bot_positions p ON p.id = t.position_id
        WHERE t.user_id = ? AND p.rank_at_entry IS NOT NULL AND t.close_execution_id IS NOT NULL
    `).all(userId);
}

// Average Entry Delay (Momentum Validation System sprint): real seconds
// between when a token was FIRST sighted as a BUY/STRONG BUY candidate
// (trading_bot_candidate_sightings, migration 052) and when it was
// actually bought - joined by (user_id, token_address). Only ever
// populated going forward, for positions opened after this sprint's
// sightings table started recording - never backfilled or guessed for
// older positions, which simply have no matching sighting row.
// LIVE-only (Production Hotfix V1.1, Section 5) - see the comment above
// findAllTradesChronological for why (p.execution_id, the position's
// own real-execution marker, is the position-level equivalent of a
// trade's close_execution_id).
function findEntryDelayValues(userId){
    return db.prepare(`
        SELECT (julianday(p.opened_at) - julianday(s.first_seen_at)) * 86400 as delaySeconds
        FROM trading_bot_positions p
        JOIN trading_bot_candidate_sightings s ON s.user_id = p.user_id AND s.token_address = p.token_address
        WHERE p.user_id = ? AND p.execution_id IS NOT NULL
    `).all(userId);
}

// Phase 2 (Live Validation & Bottleneck Elimination): same real join,
// scoped to positions opened within a rolling window - "dalam 1 jam,
// berapa Average Entry Delay" needs this, not the all-time figure.
// LIVE-only (Production Hotfix V1.1, Section 5).
function findEntryDelayValuesSince(userId, hours){
    return db.prepare(`
        SELECT (julianday(p.opened_at) - julianday(s.first_seen_at)) * 86400 as delaySeconds
        FROM trading_bot_positions p
        JOIN trading_bot_candidate_sightings s ON s.user_id = p.user_id AND s.token_address = p.token_address
        WHERE p.user_id = ? AND p.execution_id IS NOT NULL AND datetime(p.opened_at) >= datetime('now', '-' || ? || ' hours')
    `).all(userId, hours);
}

// Average Time To Peak (Momentum Validation System sprint): real seconds
// between opening a position and its own real mfe_at (the last time a
// new peak was set, migration 048/051) - works for both still-OPEN and
// CLOSED positions. Only positions that ever recorded a real positive
// excursion have a non-null mfe_at - never guessed for the rest.
// LIVE-only (Production Hotfix V1.1, Section 5).
function findTimeToPeakValues(userId){
    return db.prepare(`
        SELECT (julianday(mfe_at) - julianday(opened_at)) * 86400 as delaySeconds
        FROM trading_bot_positions
        WHERE user_id = ? AND mfe_at IS NOT NULL AND execution_id IS NOT NULL
    `).all(userId);
}

// Self-Audit / Performance Report (Momentum Validation System sprint):
// same real rank_at_entry join as above, scoped to trades closed within
// the rolling window. LIVE-only (Production Hotfix V1.1, Section 5).
function findRankAtEntryValuesSince(userId, hours){
    return db.prepare(`
        SELECT p.rank_at_entry as rankAtEntry
        FROM trading_bot_trades t
        JOIN trading_bot_positions p ON p.id = t.position_id
        WHERE t.user_id = ? AND p.rank_at_entry IS NOT NULL AND t.close_execution_id IS NOT NULL
          AND datetime(t.closed_at) >= datetime('now', '-' || ? || ' hours')
    `).all(userId, hours);
}

function countTrades(userId){
    return db.prepare("SELECT COUNT(*) as c FROM trading_bot_trades WHERE user_id = ?").get(userId).c;
}

function findRecentLog(userId, limit){
    return db.prepare("SELECT * FROM trading_bot_log WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(userId, limit || 100);
}

// Self-Audit / Performance Report (Momentum Validation System sprint):
// every real trade CLOSED within the rolling window - the proven
// datetime(col) >= datetime('now', '-N hours') convention already used
// by 5 other repositories in this codebase, no new date-math. LIVE-only
// (Production Hotfix V1.1, Section 5) - see the comment above
// findAllTradesChronological for why.
function findTradesClosedSince(userId, hours){
    return db.prepare(`
        SELECT * FROM trading_bot_trades
        WHERE user_id = ? AND close_execution_id IS NOT NULL AND datetime(closed_at) >= datetime('now', '-' || ? || ' hours')
    `).all(userId, hours);
}

// LIVE-only (Production Hotfix V1.1, Section 5) - "how many positions
// did we really open" for Founder Live Trading evaluation must never
// count a SIMULATION-mode paper position.
function countPositionsOpenedSince(userId, hours){
    return db.prepare(`
        SELECT COUNT(*) as c FROM trading_bot_positions
        WHERE user_id = ? AND execution_id IS NOT NULL AND datetime(opened_at) >= datetime('now', '-' || ? || ' hours')
    `).get(userId, hours).c;
}

// Every real cycle-summary/Filtering SYSTEM row within the window - the
// scanned/qualified counts are parsed from each row's own already-real
// meta_json (tradingBotEngine.js's runCycle) by the caller; this just
// scopes the rows by real time, not by row-count.
function findLogSince(userId, hours){
    return db.prepare(`
        SELECT * FROM trading_bot_log
        WHERE user_id = ? AND datetime(created_at) >= datetime('now', '-' || ? || ' hours')
        ORDER BY created_at ASC, id ASC
    `).all(userId, hours);
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
//
// openPositionCount/availableCash (migration 054, Phase 2): the exact
// values already in scope at tradingBotEngine.js's own call site (its
// own openCount/availableCash right after the buy loop) - carried
// through so Average Simultaneous Position / Average Idle Cash never
// need a second query, just an average over this same real, already-
// scheduled per-cycle sample. Both optional/null for any other caller.
const insertEquitySnapshotStmt = db.prepare(
    "INSERT INTO trading_bot_equity_snapshot (user_id, equity, open_position_count, available_cash) VALUES (@userId, @equity, @openPositionCount, @availableCash)"
);

function insertEquitySnapshot(userId, equity, openPositionCount = null, availableCash = null){
    insertEquitySnapshotStmt.run({ userId, equity, openPositionCount, availableCash });
}

function findEquityCurve(userId){
    return db.prepare("SELECT equity, taken_at FROM trading_bot_equity_snapshot WHERE user_id = ? ORDER BY taken_at ASC").all(userId);
}

// System Throughput (Phase 2): real average simultaneous position count
// / real average idle cash, sampled once per cycle at the same cadence
// the equity curve already uses - only over snapshots that actually
// recorded these (migration 054 going forward), scoped to a rolling
// window.
function findThroughputSamplesSince(userId, hours){
    return db.prepare(`
        SELECT open_position_count as openPositionCount, available_cash as availableCash
        FROM trading_bot_equity_snapshot
        WHERE user_id = ? AND open_position_count IS NOT NULL
          AND datetime(taken_at) >= datetime('now', '-' || ? || ' hours')
    `).all(userId, hours);
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

// Live Decision Center (migration 050): replaces this user's ENTIRE
// snapshot every cycle (delete then bulk insert, one transaction) - the
// set of qualifying tokens changes cycle to cycle, so a real diff/upsert
// would need to track disappearance too; delete+insert gets the same
// "current snapshot only" property for free and stays bounded by however
// many bounded rows this cycle actually passes in (never by scan size -
// see services/tradingBotEngine.js's runCycle, which caps this before
// calling here).
const deleteDecisionSnapshotStmt = db.prepare("DELETE FROM trading_bot_decision_snapshot WHERE user_id = ?");
const insertDecisionSnapshotStmt = db.prepare(`
    INSERT INTO trading_bot_decision_snapshot (
        user_id, token_address, token_symbol, action, confidence, risk, tier, rank, priority_score, reasons_json, target_price,
        market_age_seconds, last_snapshot_at, decision_time, snapshot_source
    ) VALUES (
        @userId, @tokenAddress, @tokenSymbol, @action, @confidence, @risk, @tier, @rank, @priorityScore, @reasonsJson, @targetPrice,
        @marketAgeSeconds, @lastSnapshotAt, @decisionTime, @snapshotSource
    )
`);

function replaceDecisionSnapshot(userId, rows){
    const tx = db.transaction(() => {
        deleteDecisionSnapshotStmt.run(userId);
        for(const row of rows){
            insertDecisionSnapshotStmt.run({
                userId,
                tokenAddress: row.tokenAddress,
                tokenSymbol: row.tokenSymbol ?? null,
                action: row.action,
                confidence: row.confidence ?? null,
                risk: row.risk ?? null,
                tier: row.tier ?? null,
                rank: row.rank ?? null,
                priorityScore: row.priorityScore ?? null,
                reasonsJson: row.reasons ? JSON.stringify(row.reasons) : null,
                // Section H (Candidate Card): real "if bought now" target
                // price for BUY/WATCH-tier candidates only - null for
                // AVOID (never computed) and honestly null when
                // buildRiskBands itself couldn't produce one (no real
                // market_cap yet).
                targetPrice: row.targetPrice ?? null,
                // Production Hotfix V1.1, Section 3: real freshness
                // observability for every candidate.
                marketAgeSeconds: row.marketAgeSeconds ?? null,
                lastSnapshotAt: row.lastSnapshotAt ?? null,
                decisionTime: row.decisionTime ?? null,
                snapshotSource: row.snapshotSource ?? null
            });
        }
    });
    tx();
}

function findDecisionSnapshot(userId){
    return db.prepare("SELECT * FROM trading_bot_decision_snapshot WHERE user_id = ? ORDER BY rank IS NULL, rank ASC, confidence DESC").all(userId);
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
    getConfig, updateConfig, setAllocationAndCapital, updateInitialCapital, markStrategySelected, markTradingConfigCustomized,
    ensureBotForUser, findRunningUserIds,
    findOpenPositions, findOpenPositionForToken, findOpenPositionById, findPositionById, countOpenPositions,
    findLastTradeForToken, findTradeByPositionId,
    insertPosition, updatePositionTracking, closePosition,
    findRecentTrades, countTrades, findAllTradesChronological, findRankAtEntryValues,
    findTradesClosedSince, countPositionsOpenedSince, findLogSince, findRankAtEntryValuesSince, findEntryDelayValues, findEntryDelayValuesSince, findTimeToPeakValues,
    findRecentLog, insertLog,
    sumClosedTrades, sumOpenPositions,
    insertEquitySnapshot, findEquityCurve, computeMaxDrawdownPct, findThroughputSamplesSince,
    replaceDecisionSnapshot, findDecisionSnapshot,
    forUser
};
