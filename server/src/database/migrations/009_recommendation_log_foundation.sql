-- "Next Foundation" for future learning (engine-quality sprint): every
-- recommendation must carry enough real, already-computed context to
-- later compute Win Rate / ROI / Expected Value / Profit Factor
-- without re-deriving it from scratch. recommendation_log already had
-- prediction_time (recorded_at), entry_price (price_at_recommendation),
-- confidence, action, reason (reasons_json) and token (token_address/
-- symbol) - this adds the two still-missing real fields: the token's
-- own market cap at recommendation time (the Trade Plan is now
-- market-cap-primary, so logging price alone is an incomplete record),
-- and a small, honest snapshot of the real participant wallet
-- composition that fed the recommendation (smart-money/KOL activity
-- counts, whether a dev wallet was identified) - not a new data
-- source, just persisting a summary of data the engine already
-- gathered for this exact call (see recommendationLoggerService.js).
ALTER TABLE recommendation_log ADD COLUMN market_cap_at_recommendation REAL;
ALTER TABLE recommendation_log ADD COLUMN wallet_summary_json TEXT;
