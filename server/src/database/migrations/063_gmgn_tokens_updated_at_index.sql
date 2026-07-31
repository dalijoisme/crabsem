-- 063_gmgn_tokens_updated_at_index.sql - Fresh BUY Universe RFC
-- (approved architecture: misty-floating-quasar.md). Additive index
-- supporting repositories/gmgnTokenRepository.js's new getFreshTokens()
-- query (services/freshUniverseService.js) - WHERE updated_at >= ...
-- AND market_cap > ... - without a full-table-scan at 300k+ rows.
-- Freshness is the more selective predicate of the two (only a small
-- fraction of gmgn_tokens is refreshed by the collector at any given
-- moment), so it leads the composite.

CREATE INDEX IF NOT EXISTS idx_gmgn_tokens_updated_at_market_cap
    ON gmgn_tokens(updated_at, market_cap);
