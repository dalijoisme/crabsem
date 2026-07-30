-- 049_trading_bot_trades_position_link.sql - Live Decision Center /
-- Signal Center sprint. Position Detail's timeline needs to join a
-- closed position to the exact trade row that closed it (real exit
-- price/reason/duration) - previously only recoverable indirectly via
-- (user_id, token_address, opened_at), which is unambiguous in practice
-- but not a real key. Additive, nullable - NULL for every trade closed
-- before this migration, never backfilled/guessed, same convention as
-- migration 046/047/048.

ALTER TABLE trading_bot_trades ADD COLUMN position_id INTEGER;
