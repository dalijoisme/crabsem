// repositories/tradingBotRepository.js - the only file that touches
// trading_bot_state/config/positions/trades/log tables. Monitoring/
// control data only this phase - no execution logic lives here.

const db = require("../database/connection");

function getState(){
    return db.prepare("SELECT * FROM trading_bot_state WHERE id = 1").get();
}

const updateStateStmt = db.prepare(`
    UPDATE trading_bot_state
    SET status = @status, mode = @mode, last_action = @lastAction, last_action_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
`);

function updateState({ status, mode, lastAction }){
    const current = getState();
    updateStateStmt.run({
        status: status ?? current.status,
        mode: mode ?? current.mode,
        lastAction: lastAction ?? current.last_action
    });
    return getState();
}

function getConfig(){
    return db.prepare("SELECT * FROM trading_bot_config WHERE id = 1").get();
}

const CONFIG_FIELDS = [
    "initial_capital", "position_size_pct", "max_position_size", "max_open_positions",
    "min_order_size", "fee_pct", "slippage_pct", "one_position_per_token", "scan_interval_seconds"
];

function updateConfig(partial){
    const current = getConfig();
    const merged = {};
    for(const field of CONFIG_FIELDS){
        merged[field] = partial[field] != null ? partial[field] : current[field];
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
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
    `).run(merged);
    return getConfig();
}

function findOpenPositions(){
    return db.prepare("SELECT * FROM trading_bot_positions WHERE status = 'OPEN' ORDER BY opened_at DESC").all();
}

function findRecentTrades(limit){
    return db.prepare("SELECT * FROM trading_bot_trades ORDER BY created_at DESC LIMIT ?").all(limit || 100);
}

function countTrades(){
    return db.prepare("SELECT COUNT(*) as c FROM trading_bot_trades").get().c;
}

function findRecentLog(limit){
    return db.prepare("SELECT * FROM trading_bot_log ORDER BY created_at DESC, id DESC LIMIT ?").all(limit || 100);
}

const insertLogStmt = db.prepare(`
    INSERT INTO trading_bot_log (log_type, token_symbol, message, meta_json)
    VALUES (@logType, @tokenSymbol, @message, @metaJson)
`);

function insertLog({ logType, tokenSymbol, message, meta }){
    insertLogStmt.run({
        logType,
        tokenSymbol: tokenSymbol ?? null,
        message,
        metaJson: meta ? JSON.stringify(meta) : null
    });
}

function sumClosedTrades(){
    return db.prepare(`
        SELECT
            COUNT(*) as closedCount,
            COALESCE(SUM(CASE WHEN roi_pct > 0 THEN 1 ELSE 0 END), 0) as winCount,
            COALESCE(SUM(CASE WHEN roi_pct <= 0 THEN 1 ELSE 0 END), 0) as lossCount,
            COALESCE(SUM((size_usd * roi_pct / 100.0)), 0) as realizedPnl,
            COALESCE(SUM(fee_usd), 0) as totalFees,
            COALESCE(SUM(CASE WHEN roi_pct > 0 THEN (size_usd * roi_pct / 100.0) ELSE 0 END), 0) as grossWin,
            COALESCE(SUM(CASE WHEN roi_pct <= 0 THEN ABS(size_usd * roi_pct / 100.0) ELSE 0 END), 0) as grossLoss
        FROM trading_bot_trades
        WHERE closed_at IS NOT NULL
    `).get();
}

function sumOpenPositions(){
    return db.prepare(`
        SELECT
            COUNT(*) as openCount,
            COALESCE(SUM(size_usd), 0) as openValueAtEntry,
            COALESCE(SUM(size_usd * (COALESCE(current_price, entry_price) / entry_price)), 0) as openMarketValue
        FROM trading_bot_positions
        WHERE status = 'OPEN'
    `).get();
}

module.exports = {
    getState, updateState,
    getConfig, updateConfig,
    findOpenPositions, findRecentTrades, countTrades,
    findRecentLog, insertLog,
    sumClosedTrades, sumOpenPositions
};
