-- 019_trenches_token_address_index.sql - performance fix discovered
-- while load-testing the redesigned prediction pipeline: gmgn_trenches
-- only had a composite UNIQUE(section, token_address) autoindex, which
-- cannot be used for a plain "WHERE token_address = ?" lookup (section
-- is the leading column) - every call to
-- gmgnTrenchesRepository.findByTokenAddress() was silently doing a full
-- table scan. Harmless at the old, low decision-throughput (called
-- rarely), but the new quality gate calls this for EVERY scanned token
-- every cycle - measured at ~114ms/call (full scan) before this index,
-- collapsing to a real indexed seek after it.

CREATE INDEX idx_gmgn_trenches_token_address ON gmgn_trenches(token_address);
