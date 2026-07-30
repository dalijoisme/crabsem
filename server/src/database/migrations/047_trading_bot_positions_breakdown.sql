-- 047_trading_bot_positions_breakdown.sql - Trust/UX sprint. Only a
-- single confidence float was ever persisted at open time - the full
-- module-by-module breakdown (participant/market scores, acceleration
-- signal, reasons) researchEngineFactory.js already computes was
-- discarded seconds after being used, so no position could ever explain
-- itself later. Additive, nullable - identical bug/fix shape to the
-- ranking-priority sprint's own "computed then discarded" fix, one more
-- field. NULL for every position opened before this migration - never
-- backfilled/guessed, same convention as migration 046's tx_hash.

ALTER TABLE trading_bot_positions ADD COLUMN breakdown_json TEXT;
