-- Recommendation Lifecycle sprint: the live-recommendation overlay
-- (services/liveRecommendationService.js) needs the risk label from
-- the token's last real decision, alongside the recommendation/
-- confidence/score fields token_last_decision already tracks, so the
-- homepage can show a real, engine-computed risk instead of falling
-- back to a fresh (and now-bypassed) intelligenceEngine call.
-- Plain ADD COLUMN - no rebuild, no FK dance required.

ALTER TABLE token_last_decision ADD COLUMN last_risk TEXT;
